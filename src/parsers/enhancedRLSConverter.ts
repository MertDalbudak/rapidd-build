/**
 * Enhanced RLS Converter using Deep SQL Analysis
 */

import { DeepSQLAnalyzer, SQLAnalysis } from './deepSQLAnalyzer';
import { PrismaFilterBuilder, ModelInfo, RelationshipInfo } from './prismaFilterBuilder';

export interface EnhancedConverter {
  convertToJavaScript: (sql: string, dataVar?: string, userVar?: string, modelName?: string | null) => string;
  convertToPrismaFilter: (sql: string, userVar?: string, modelName?: string | null) => string;
  getUserContextRequirements: (sql: string) => Record<string, boolean>;
  analyzer: DeepSQLAnalyzer;
}

export function createEnhancedConverter(
  functionMappings: Record<string, unknown> = {},
  sessionVariables: string[] | Record<string, unknown> = {},
  models: Record<string, ModelInfo> = {},
  relationships: Record<string, Record<string, RelationshipInfo>> = {}
): EnhancedConverter {
  const analyzer = new DeepSQLAnalyzer();
  const filterBuilder = new PrismaFilterBuilder(models, relationships);

  /**
   * Convert PostgreSQL RLS to JavaScript with deep analysis
   */
  function convertToJavaScript(sql: string, dataVar: string = 'data', userVar: string = 'user', modelName: string | null = null): string {
    if (!sql || sql.trim() === '') {
      return 'true';
    }

    // Use deep analysis
    const analysis = analyzer.analyzeSQLForFilters(sql);
    analysis.sql = sql; // Store original SQL for OR/AND detection

    // If we have models and relationships, use the filter builder for better JavaScript
    if (modelName && Object.keys(models).length > 0) {
      return filterBuilder.buildJavaScriptCondition(modelName, analysis, dataVar, userVar);
    }

    // Fallback to simple JavaScript generation
    const conditions: string[] = [];

    // Add filter-based conditions
    for (const filter of analysis.filters) {
      if (filter.type.startsWith('user_') || filter.type.startsWith('session_')) {
        // Dynamic user field comparison
        const userField = filter.userField || filter.type.replace(/^(user_|session_)/, '');
        conditions.push(`${dataVar}?.${filter.field} === ${userVar}?.${userField}`);
      } else {
        switch (filter.type) {
          case 'equal':
            if (isNaN(Number(filter.value)) && filter.value !== 'true' && filter.value !== 'false') {
              conditions.push(`${dataVar}?.${filter.field} === '${filter.value}'`);
            } else {
              conditions.push(`${dataVar}?.${filter.field} === ${filter.value}`);
            }
            break;
          case 'not_equal':
            conditions.push(`${dataVar}?.${filter.field} !== '${filter.value}'`);
            break;
          case 'is_null':
            conditions.push(`${dataVar}?.${filter.field} === null`);
            break;
          case 'not_null':
            conditions.push(`${dataVar}?.${filter.field} !== null`);
            break;
          case 'in':
            conditions.push(`[${filter.values!.join(', ')}].includes(${dataVar}?.${filter.field})`);
            break;
        }
      }
    }

    // Add condition-based checks (roles, etc.)
    for (const condition of analysis.conditions) {
      if (condition.javascript) {
        // Replace user placeholder with actual variable
        const jsCondition = condition.javascript.replace(/user/g, userVar);
        conditions.push(jsCondition);
      } else if (condition.type === 'role_any') {
        conditions.push(`[${condition.roles!.map(r => `'${r}'`).join(', ')}].includes(${userVar}?.role)`);
      } else if (condition.type === 'role_equal') {
        conditions.push(`${userVar}?.role === '${condition.role}'`);
      }
    }

    // Handle OR/AND logic in original SQL
    const normalizedSql = sql.trim().replace(/\s+/g, ' ');

    // Check if the entire expression is OR'd
    if (normalizedSql.includes(' OR ') && !normalizedSql.includes(' AND ')) {
      // If we have multiple conditions and SQL uses OR, join with ||
      if (conditions.length > 1) {
        return conditions.join(' || ');
      }
    } else if (normalizedSql.includes(' AND ') && conditions.length > 1) {
      // If SQL uses AND, wrap in parentheses for clarity
      return '(' + conditions.join(' && ') + ')';
    }

    // Default: join with AND
    return conditions.length > 0 ? conditions.join(' && ') : 'true';
  }

  /**
   * Convert to Prisma filter with deep analysis
   */
  function convertToPrismaFilter(sql: string, userVar: string = 'user', modelName: string | null = null): string {
    if (!sql || sql.trim() === '') return '{}';

    // Use deep analysis
    const analysis = analyzer.analyzeSQLForFilters(sql);
    analysis.sql = sql; // Store original SQL for OR/AND detection

    // If we have models and relationships, use the filter builder
    if (modelName && Object.keys(models).length > 0) {
      return filterBuilder.buildFilter(modelName, analysis, userVar);
    }

    // Fallback to simple filter generation
    const filters: string[] = [];

    for (const filter of analysis.filters) {
      if (filter.type.startsWith('user_') || filter.type.startsWith('session_')) {
        // Dynamic user field comparison
        const userField = filter.userField || filter.type.replace(/^(user_|session_)/, '');
        filters.push(`{ ${filter.field}: ${userVar}?.${userField} }`);
      } else {
        switch (filter.type) {
          case 'equal':
            if (isNaN(Number(filter.value)) && filter.value !== 'true' && filter.value !== 'false') {
              filters.push(`{ ${filter.field}: '${filter.value}' }`);
            } else {
              filters.push(`{ ${filter.field}: ${filter.value} }`);
            }
            break;
          case 'not_equal':
            filters.push(`{ ${filter.field}: { not: '${filter.value}' } }`);
            break;
          case 'is_null':
            filters.push(`{ ${filter.field}: null }`);
            break;
          case 'not_null':
            filters.push(`{ ${filter.field}: { not: null } }`);
            break;
          case 'in':
            filters.push(`{ ${filter.field}: { in: [${filter.values!.join(', ')}] } }`);
            break;
        }
      }
    }

    // Role checks can't be directly filtered in Prisma (they're runtime checks)
    // But we can still return the data filters

    if (filters.length === 0) {
      return '{}';
    }

    if (filters.length === 1) {
      return filters[0];
    }

    // Check if original SQL uses OR or AND
    const normalizedSql = sql.trim().replace(/\s+/g, ' ');

    if (normalizedSql.includes(' OR ') && !normalizedSql.includes(' AND ')) {
      // Use OR for multiple filters
      return `{ OR: [${filters.join(', ')}] }`;
    }

    // Default to AND
    return `{ AND: [${filters.join(', ')}] }`;
  }

  /**
   * Analyze and get user context requirements
   */
  function getUserContextRequirements(sql: string): Record<string, boolean> {
    const analysis = analyzer.analyzeSQLForFilters(sql);
    return analysis.userContext || {};
  }

  return {
    convertToJavaScript,
    convertToPrismaFilter,
    getUserContextRequirements,
    analyzer // Expose analyzer for debugging
  };
}

export { createEnhancedConverter as default };
