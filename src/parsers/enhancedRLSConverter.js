/**
 * Enhanced RLS Converter using Deep SQL Analysis
 */

const DeepSQLAnalyzer = require('./deepSQLAnalyzer');
const PrismaFilterBuilder = require('./prismaFilterBuilder');

function createEnhancedConverter(functionMappings = {}, sessionVariables = {}, models = {}, relationships = {}) {
  const analyzer = new DeepSQLAnalyzer();
  const filterBuilder = new PrismaFilterBuilder(models, relationships);

  /**
   * Convert PostgreSQL RLS to JavaScript with deep analysis
   */
  function convertToJavaScript(sql, dataVar = 'data', userVar = 'user', modelName = null) {
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
    const conditions = [];

    // Add filter-based conditions
    for (const filter of analysis.filters) {
      if (filter.type.startsWith('user_') || filter.type.startsWith('session_')) {
        // Dynamic user field comparison
        const userField = filter.userField || filter.type.replace(/^(user_|session_)/, '');
        conditions.push(`${dataVar}?.${filter.field} === ${userVar}?.${userField}`);
      } else {
        switch (filter.type) {
          case 'equal':
            if (isNaN(filter.value) && filter.value !== 'true' && filter.value !== 'false') {
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
            conditions.push(`[${filter.values.join(', ')}].includes(${dataVar}?.${filter.field})`);
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
        conditions.push(`[${condition.roles.map(r => `'${r}'`).join(', ')}].includes(${userVar}?.role)`);
      } else if (condition.type === 'role_equal') {
        conditions.push(`${userVar}?.role === '${condition.role}'`);
      }
    }

    // Handle OR/AND logic in original SQL
    sql = sql.trim().replace(/\s+/g, ' ');

    // Check if the entire expression is OR'd
    if (sql.includes(' OR ') && !sql.includes(' AND ')) {
      // If we have multiple conditions and SQL uses OR, join with ||
      if (conditions.length > 1) {
        return conditions.join(' || ');
      }
    } else if (sql.includes(' AND ') && conditions.length > 1) {
      // If SQL uses AND, wrap in parentheses for clarity
      return '(' + conditions.join(' && ') + ')';
    }

    // Default: join with AND
    return conditions.length > 0 ? conditions.join(' && ') : 'true';
  }

  /**
   * Convert to Prisma filter with deep analysis
   */
  function convertToPrismaFilter(sql, userVar = 'user', modelName = null) {
    if (!sql || sql.trim() === '') return '{}';

    // Use deep analysis
    const analysis = analyzer.analyzeSQLForFilters(sql);
    analysis.sql = sql; // Store original SQL for OR/AND detection

    // If we have models and relationships, use the filter builder
    if (modelName && Object.keys(models).length > 0) {
      return filterBuilder.buildFilter(modelName, analysis, userVar);
    }

    // Fallback to simple filter generation
    const filters = [];

    for (const filter of analysis.filters) {
      if (filter.type.startsWith('user_') || filter.type.startsWith('session_')) {
        // Dynamic user field comparison
        const userField = filter.userField || filter.type.replace(/^(user_|session_)/, '');
        filters.push(`{ ${filter.field}: ${userVar}?.${userField} }`);
      } else {
        switch (filter.type) {
          case 'equal':
            if (isNaN(filter.value) && filter.value !== 'true' && filter.value !== 'false') {
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
            filters.push(`{ ${filter.field}: { in: [${filter.values.join(', ')}] } }`);
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
    sql = sql.trim().replace(/\s+/g, ' ');

    if (sql.includes(' OR ') && !sql.includes(' AND ')) {
      // Use OR for multiple filters
      return `{ OR: [${filters.join(', ')}] }`;
    }

    // Default to AND
    return `{ AND: [${filters.join(', ')}] }`;
  }

  /**
   * Analyze and get user context requirements
   */
  function getUserContextRequirements(sql) {
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

module.exports = { createEnhancedConverter };