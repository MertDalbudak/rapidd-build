/**
 * Deep SQL Analyzer for PostgreSQL RLS Policies
 * Uses extensive regex patterns to extract meaning from SQL expressions
 */

class DeepSQLAnalyzer {
  constructor() {
    // Common PostgreSQL function patterns mapped to user fields
    this.functionMappings = {
      // User ID functions
      'get_current_user_id': 'id',
      'current_user_id': 'id',
      'auth.uid': 'id',
      'auth.user_id': 'id',

      // Role functions
      'get_current_user_role': 'role',
      'current_user_role': 'role',
      'current_role': 'role',
      'auth.role': 'role',

      // Tenant functions
      'get_current_tenant_id': 'tenant_id',
      'current_tenant_id': 'tenant_id',
      'current_tenant': 'tenant_id',

      // Organization functions
      'get_current_org_id': 'org_id',
      'current_org_id': 'org_id',
      'current_organization_id': 'org_id',

      // Related entity functions
      'get_current_student_id': 'student_id',
      'current_student_id': 'student_id',
      'get_student_id_for_user': 'student_id',

      'get_current_teacher_id': 'teacher_id',
      'current_teacher_id': 'teacher_id',
      'get_teacher_id_for_user': 'teacher_id',

      'get_current_employee_id': 'employee_id',
      'current_employee_id': 'employee_id',
      'get_employee_id_for_user': 'employee_id',

      'get_current_customer_id': 'customer_id',
      'current_customer_id': 'customer_id',
      'get_customer_id_for_user': 'customer_id'
    };

    // Session variable mappings
    this.sessionMappings = {
      'app.current_user_id': 'id',
      'jwt.claims.sub': 'id',
      'request.jwt.claims.sub': 'id',
      'request.jwt.claim.sub': 'id',

      'app.current_role': 'role',
      'jwt.claims.role': 'role',
      'request.jwt.claim.role': 'role',

      'app.current_tenant': 'tenant_id',
      'app.tenant_id': 'tenant_id',
      'jwt.claims.tenant_id': 'tenant_id',

      'app.org_id': 'org_id',
      'app.organization_id': 'org_id'
    };
  }

  /**
   * Analyze SQL expression and extract Prisma filters
   */
  analyzeSQLForFilters(sql) {
    if (!sql || sql.trim() === '') {
      return { filters: [], conditions: [], userContext: {} };
    }

    const analysis = {
      filters: [],
      conditions: [],
      userContext: {}
    };

    // Normalize SQL
    sql = this.normalizeSql(sql);

    // Remove EXISTS subqueries with proper parentheses matching
    const sqlWithoutExists = this.removeExistsSubqueries(sql);

    // Extract different types of conditions (use sqlWithoutExists to avoid EXISTS internals)
    this.extractDirectComparisons(sqlWithoutExists, analysis);
    this.extractFunctionComparisons(sqlWithoutExists, analysis);
    this.extractSessionVariableComparisons(sqlWithoutExists, analysis);
    this.extractInClauses(sqlWithoutExists, analysis);

    // Extract EXISTS from original SQL
    this.extractExistsSubqueries(sql, analysis);

    // Extract from original SQL for these
    this.extractCaseWhenConditions(sql, analysis);
    this.extractRoleChecks(sql, analysis);
    this.extractComplexJoins(sql, analysis);

    return analysis;
  }

  /**
   * Normalize SQL for easier parsing
   */
  normalizeSql(sql) {
    let normalized = sql
      .replace(/\s+/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/::character varying/gi, '') // Remove multi-word type casts first
      .replace(/::[\w_]+\s*\[\]/g, ']') // Replace ::type[] with just ] (preserve array bracket)
      .replace(/::[\w_]+/g, '') // Remove simple type casts
      .trim();

    // Remove balanced outer wrapping parentheses
    while (normalized.startsWith('(') && normalized.endsWith(')')) {
      const inner = normalized.slice(1, -1);
      // Count parentheses to check if outer pair is balanced
      let depth = 0;
      let isBalanced = true;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '(') depth++;
        if (inner[i] === ')') depth--;
        // If depth goes negative, the outer parens are needed
        if (depth < 0) {
          isBalanced = false;
          break;
        }
      }
      // Only remove if balanced and not a single function call
      if (isBalanced && depth === 0 && (inner.includes(' = ') || inner.includes(' AND ') || inner.includes(' OR '))) {
        normalized = inner.trim();
      } else {
        break;
      }
    }

    return normalized;
  }

  /**
   * Remove EXISTS subqueries with proper parentheses matching
   */
  removeExistsSubqueries(sql) {
    let result = sql;
    let changed = true;

    // Keep removing EXISTS clauses until none are left
    while (changed) {
      changed = false;
      const existsIndex = result.search(/EXISTS\s*\(/i);

      if (existsIndex !== -1) {
        // Find the matching closing parenthesis
        const startParen = result.indexOf('(', existsIndex);
        let depth = 1;
        let endParen = startParen + 1;

        while (endParen < result.length && depth > 0) {
          if (result[endParen] === '(') depth++;
          if (result[endParen] === ')') depth--;
          endParen++;
        }

        // Replace EXISTS(...) with 'true'
        result = result.substring(0, existsIndex) + 'true' + result.substring(endParen);
        changed = true;
      }
    }

    return result;
  }

  /**
   * Extract direct field comparisons
   */
  extractDirectComparisons(sql, analysis) {
    // Pattern: field = 'value' (with or without quotes on field name)
    const stringPattern = /(?:"?(\w+)"?)\s*=\s*'([^']+)'/gi;
    let match;
    while ((match = stringPattern.exec(sql)) !== null) {
      const field = match[1];
      const value = match[2];

      // Skip if field is actually a function
      if (field.toLowerCase().includes('current') || field.toLowerCase().includes('get')) {
        continue;
      }

      analysis.filters.push({
        type: 'equal',
        field: field,
        value: value,
        prisma: `{ ${field}: '${value}' }`
      });
    }

    // Pattern: field = number (with or without quotes on field name)
    const numberPattern = /(?:"?(\w+)"?)\s*=\s*(\d+)(?!\s*\))/gi;
    while ((match = numberPattern.exec(sql)) !== null) {
      const field = match[1];
      const value = match[2];

      // Skip if field is actually a function
      if (field.toLowerCase().includes('current') || field.toLowerCase().includes('get')) {
        continue;
      }

      analysis.filters.push({
        type: 'equal',
        field: field,
        value: value,
        prisma: `{ ${field}: ${value} }`
      });
    }

    // Pattern: field = true/false (with or without quotes on field name)
    const booleanPattern = /(?:"?(\w+)"?)\s*=\s*(true|false)/gi;
    while ((match = booleanPattern.exec(sql)) !== null) {
      const field = match[1];
      const value = match[2].toLowerCase();

      analysis.filters.push({
        type: 'equal',
        field: field,
        value: value,
        prisma: `{ ${field}: ${value} }`
      });
    }

    // Pattern: field IS NULL
    const isNullPattern = /(?:"?(\w+)"?)\s+IS\s+NULL/gi;
    while ((match = isNullPattern.exec(sql)) !== null) {
      analysis.filters.push({
        type: 'is_null',
        field: match[1],
        prisma: `{ ${match[1]}: null }`
      });
    }

    // Pattern: field IS NOT NULL
    const isNotNullPattern = /(\w+)\s+IS\s+NOT\s+NULL/gi;
    while ((match = isNotNullPattern.exec(sql)) !== null) {
      analysis.filters.push({
        type: 'not_null',
        field: match[1],
        prisma: `{ ${match[1]}: { not: null } }`
      });
    }
  }

  /**
   * Extract function-based comparisons
   */
  extractFunctionComparisons(sql, analysis) {
    // Pattern: field = function() (with or without quotes on field name)
    const patterns = [
      /(?:"?(\w+)"?)\s*=\s*([\w.]+)\s*\(\s*\)/gi,  // field = function()
      /([\w.]+)\s*\(\s*\)\s*=\s*(?:"?(\w+)"?)/gi   // function() = field
    ];

    // Normalize dots in function names for lookup
    const normalizeFuncName = (name) => name.replace(/\./g, '_');

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        let field, funcName;

        // First pattern is: field = function()
        // Second pattern is: function() = field
        if (i === 0) {
          field = match[1];
          funcName = normalizeFuncName(match[2]);
        } else {
          funcName = normalizeFuncName(match[1]);
          field = match[2];
        }

        // Look up function mapping (check both with/without underscore and original)
        let userField = this.functionMappings[funcName] || this.functionMappings[funcName.toLowerCase()];

        // Also try the original name without normalization
        if (!userField) {
          const originalName = (i === 0 ? match[2] : match[1]);
          userField = this.functionMappings[originalName] || this.functionMappings[originalName.toLowerCase()];
        }

        if (userField) {
          // Skip if field is actually a function (e.g., both sides are functions)
          if (field.toLowerCase().includes('current') || field.toLowerCase().includes('get') || field.includes('(')) {
            continue;
          }

          // Skip if this is part of an ANY clause (handled by extractRoleChecks)
          if (sql.includes(match[0] + ' = ANY') || sql.includes(match[0] + '= ANY') ||
              sql.includes(match[0] + ' =ANY') || sql.includes(match[0] + '=ANY')) {
            continue;
          }

          analysis.filters.push({
            type: `user_${userField}`,
            field: field,
            userField: userField,
            prisma: `{ ${field}: user?.${userField} }`
          });

          // Track user context requirements
          const contextKey = `requires${userField.charAt(0).toUpperCase()}${userField.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase())}`;
          analysis.userContext[contextKey] = true;
        }
      }
    }

    // Pattern: function() = 'value'
    const funcValuePattern = /([\w.]+)\s*\(\s*\)\s*=\s*'([^']+)'/gi;
    let match;
    while ((match = funcValuePattern.exec(sql)) !== null) {
      const funcName = match[1].replace(/\./g, '_');
      const value = match[2];

      const userField = this.functionMappings[funcName] || this.functionMappings[funcName.toLowerCase()];

      if (userField === 'role') {
        analysis.conditions.push({
          type: 'role_equal',
          role: value,
          javascript: `user?.role === '${value}'`
        });
        analysis.userContext.requiresRole = true;
      }
    }
  }

  /**
   * Extract session variable comparisons
   */
  extractSessionVariableComparisons(sql, analysis) {
    // Pattern: field = current_setting('...')
    const patterns = [
      /(\w+)\s*=\s*(?:\(?\s*current_setting\s*\(\s*'([^']+)'[^)]*\)\s*\)?)/gi,
      /current_setting\s*\(\s*'([^']+)'[^)]*\)\s*=\s*(\w+)/gi
    ];

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        let field, setting;

        // First pattern: field = current_setting(...)
        // Second pattern: current_setting(...) = field
        if (i === 0) {
          field = match[1];
          setting = match[2];
        } else {
          setting = match[1];
          field = match[2];
        }

        const userField = this.sessionMappings[setting];

        if (userField) {
          // Skip if field is actually a function
          if (field.includes('(')) continue;

          analysis.filters.push({
            type: `session_${userField}`,
            field: field,
            userField: userField,
            prisma: `{ ${field}: user?.${userField} }`
          });

          // Track user context requirements
          const contextKey = `requires${userField.charAt(0).toUpperCase()}${userField.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase())}`;
          analysis.userContext[contextKey] = true;
        }
      }
    }
  }

  /**
   * Extract IN clauses
   */
  extractInClauses(sql, analysis) {
    // Pattern: field IN (values)
    const inPattern = /(\w+)\s+IN\s*\(([^)]+)\)/gi;
    let match;

    while ((match = inPattern.exec(sql)) !== null) {
      const field = match[1];
      const values = match[2];

      // Skip if field is a function
      if (field.toLowerCase().includes('current') || field.toLowerCase().includes('get')) {
        continue;
      }

      // Check if it's a subquery
      if (values.toLowerCase().includes('select')) {
        // Handle subquery
        analysis.conditions.push({
          type: 'in_subquery',
          field: field,
          subquery: values,
          prisma: `/* IN subquery for ${field} - requires manual implementation */`
        });
      } else {
        // Parse values
        const valueList = values
          .split(',')
          .map(v => v.trim().replace(/'/g, ''));

        const quotedValues = valueList.map(v =>
          isNaN(v) && v !== 'true' && v !== 'false' ? `'${v}'` : v
        );

        analysis.filters.push({
          type: 'in',
          field: field,
          values: quotedValues,
          prisma: `{ ${field}: { in: [${quotedValues.join(', ')}] } }`
        });
      }
    }
  }

  /**
   * Extract EXISTS subqueries
   */
  extractExistsSubqueries(sql, analysis) {
    const existsPattern = /EXISTS\s*\(([^)]+(?:\([^)]*\)[^)]*)*)\)/gi;
    let match;

    while ((match = existsPattern.exec(sql)) !== null) {
      const subquery = match[1];

      // Try to extract the table and join condition
      const fromMatch = subquery.match(/FROM\s+(\w+)/i);
      const whereMatch = subquery.match(/WHERE\s+(.+)/i);

      if (fromMatch) {
        const table = fromMatch[1];
        const condition = whereMatch ? whereMatch[1] : '';

        analysis.conditions.push({
          type: 'exists',
          table: table,
          condition: condition,
          prisma: `/* EXISTS check on ${table} - implement as relation check */`
        });
      }
    }
  }

  /**
   * Extract CASE WHEN conditions
   */
  extractCaseWhenConditions(sql, analysis) {
    const casePattern = /CASE\s+WHEN\s+([^THEN]+)\s+THEN\s+([^WHEN|ELSE|END]+)(?:\s+WHEN\s+([^THEN]+)\s+THEN\s+([^WHEN|ELSE|END]+))*(?:\s+ELSE\s+([^END]+))?\s+END/gi;
    let match;

    while ((match = casePattern.exec(sql)) !== null) {
      const conditions = [];

      // Extract WHEN conditions
      const whenPattern = /WHEN\s+([^THEN]+)\s+THEN\s+([^WHEN|ELSE|END]+)/gi;
      let whenMatch;

      while ((whenMatch = whenPattern.exec(match[0])) !== null) {
        const condition = whenMatch[1].trim();
        const result = whenMatch[2].trim();

        conditions.push({
          condition: condition,
          result: result
        });
      }

      if (conditions.length > 0) {
        analysis.conditions.push({
          type: 'case_when',
          conditions: conditions,
          prisma: `/* CASE WHEN logic - requires conditional implementation */`
        });
      }
    }
  }

  /**
   * Extract role-based checks
   */
  extractRoleChecks(sql, analysis) {
    // Pattern: (function()) = ANY((ARRAY[...])) or function() = ANY(ARRAY[...])
    // Handle optional wrapping parens around function and multiple parens around ARRAY
    const anyArrayPattern = /\(?([\w.]+)\s*\(\s*\)\)?\s*=\s*ANY\s*\(+\s*(?:ARRAY\s*)?\[([^\]]+)\]/gi;
    let match;

    while ((match = anyArrayPattern.exec(sql)) !== null) {
      const funcName = match[1].replace(/\./g, '_');
      const values = match[2];

      const userField = this.functionMappings[funcName] || this.functionMappings[funcName.toLowerCase()];

      if (userField === 'role') {
        const roles = values
          .split(',')
          .map(r => r.trim().replace(/'/g, ''));

        analysis.conditions.push({
          type: 'role_any',
          roles: roles,
          javascript: `[${roles.map(r => `'${r}'`).join(', ')}].includes(user?.role)`
        });
        analysis.userContext.requiresRole = true;
      }
    }
  }

  /**
   * Extract complex JOIN conditions
   */
  extractComplexJoins(sql, analysis) {
    // Look for patterns that suggest relationships
    const relationPatterns = [
      // user owns resource through intermediate table
      /(\w+)\s+IN\s*\(\s*SELECT\s+\w+\s+FROM\s+(\w+)\s+WHERE\s+(\w+)=/gi,
      // team/group membership
      /(\w+)\.(\w+)\s+IN\s*\(\s*SELECT\s+\w+\s+FROM\s+(\w+_members?)\s+WHERE/gi
    ];

    for (const pattern of relationPatterns) {
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        if (match[2]) {
          analysis.conditions.push({
            type: 'relation',
            table: match[2],
            field: match[1],
            prisma: `/* Relation check through ${match[2]} table */`
          });
        }
      }
    }
  }
}

module.exports = DeepSQLAnalyzer;