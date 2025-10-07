/**
 * Automatic PostgreSQL RLS to JavaScript Converter
 * Uses dynamic function analysis - no hardcoding!
 */

/**
 * Create a converter with analyzed function mappings
 */
function createConverter(functionMappings = {}, sessionVariables = {}) {

  /**
   * Convert PostgreSQL RLS to JavaScript
   */
  function convertToJavaScript(sql, dataVar = 'data', userVar = 'user') {
    if (!sql || sql.trim() === '') {
      return 'true';
    }

    sql = sql.trim().replace(/\s+/g, ' ').replace(/\n/g, ' ');

    // Handle CASE WHEN
    if (sql.toUpperCase().startsWith('CASE')) {
      return convertCaseWhen(sql, dataVar, userVar);
    }

    // Handle OR
    const orParts = splitLogicalOperator(sql, 'OR');
    if (orParts.length > 1) {
      return orParts.map(part => convertToJavaScript(part, dataVar, userVar)).join(' || ');
    }

    // Handle AND
    const andParts = splitLogicalOperator(sql, 'AND');
    if (andParts.length > 1) {
      return '(' + andParts.map(part => convertToJavaScript(part, dataVar, userVar)).join(' && ') + ')';
    }

    // Handle function = ANY (ARRAY[...])
    const funcAnyMatch = sql.match(/(\w+)\s*\([^)]*\)[^=]*=\s*ANY\s*\(\s*(?:\()?ARRAY\s*\[([^\]]+)\]/i);
    if (funcAnyMatch) {
      const funcName = funcAnyMatch[1];
      const arrayValues = extractArrayValues(funcAnyMatch[2]);

      // Use analyzed mapping or fallback
      const jsExpression = getFunctionMapping(funcName, userVar);
      return `[${arrayValues}].includes(${jsExpression})`;
    }

    // Handle function() = 'value' (e.g., get_current_user_role() = 'admin')
    const funcValueMatch = sql.match(/(\w+)\s*\([^)]*\)\s*=\s*'([^']+)'/i);
    if (funcValueMatch) {
      const funcName = funcValueMatch[1];
      const value = funcValueMatch[2];

      const jsExpression = getFunctionMapping(funcName, userVar);
      return `${jsExpression} === '${value}'`;
    }

    // Handle field = function()
    const fieldFuncMatch = sql.match(/(\w+)\s*=\s*(\w+)\s*\([^)]*\)/i);
    if (fieldFuncMatch) {
      const field = fieldFuncMatch[1];
      const funcName = fieldFuncMatch[2];

      const jsExpression = getFunctionMapping(funcName, userVar);
      return `${dataVar}?.${field} === ${jsExpression}`;
    }

    // Handle current_setting
    const settingMatch = sql.match(/(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'([^']+)'/i);
    if (settingMatch) {
      const field = settingMatch[1];
      const setting = settingMatch[2];

      const jsExpression = getSessionMapping(setting, userVar);
      return `${dataVar}?.${field} === ${jsExpression}`;
    }

    // Handle EXISTS
    if (sql.includes('EXISTS')) {
      // Try to extract table and conditions for better TODO comment
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      const table = tableMatch ? tableMatch[1] : 'related_table';
      return `true /* TODO: Check ${table} relationship */`;
    }

    // Handle boolean literals
    if (sql.toLowerCase() === 'true') return 'true';
    if (sql.toLowerCase() === 'false') return 'false';

    return `true /* Unhandled: ${sql.substring(0, 50)}... */`;
  }

  /**
   * Get JavaScript mapping for a PostgreSQL function
   */
  function getFunctionMapping(funcName, userVar) {
    // Check analyzed mappings first
    if (functionMappings[funcName]) {
      const mapping = functionMappings[funcName];
      if (mapping.javascript) {
        // Replace 'user' placeholder with actual variable name
        return mapping.javascript.replace(/user/g, userVar);
      }
    }

    // Special case for role functions - they should map to user?.role not user?.user_role
    if (funcName.toLowerCase() === 'get_current_user_role' ||
        funcName.toLowerCase() === 'current_user_role') {
      return `${userVar}?.role`;
    }

    // Fallback: infer from function name
    // get_current_X -> user?.X
    const getCurrentMatch = funcName.match(/get_current_(\w+)/i);
    if (getCurrentMatch) {
      return `${userVar}?.${getCurrentMatch[1]}`;
    }

    // current_X -> user?.X
    const currentMatch = funcName.match(/current_(\w+)/i);
    if (currentMatch) {
      return `${userVar}?.${currentMatch[1]}`;
    }

    // Unknown function
    return `${userVar}?.${funcName}()`;
  }

  /**
   * Get JavaScript mapping for a session variable
   */
  function getSessionMapping(setting, userVar) {
    // Check analyzed mappings
    if (sessionVariables[setting]) {
      return sessionVariables[setting].replace(/user/g, userVar);
    }

    // Fallback: infer from setting name
    if (setting.includes('user_id')) {
      return `${userVar}?.id`;
    }

    const parts = setting.split('.');
    const lastPart = parts[parts.length - 1];
    return `${userVar}?.${lastPart}`;
  }

  /**
   * Convert CASE WHEN
   */
  function convertCaseWhen(sql, dataVar, userVar) {
    const caseMatch = sql.match(/CASE\s+([^W]+)\s+((?:WHEN[\s\S]+?)+)(?:\s+ELSE\s+([\s\S]+?))?\s*END/i);
    if (!caseMatch) return 'false';

    const caseExpr = caseMatch[1].trim();
    const whenClauses = caseMatch[2];
    const elseClause = caseMatch[3];

    // Extract function name from CASE expression
    const funcMatch = caseExpr.match(/(\w+)\s*\(/);
    const testExpression = funcMatch ? getFunctionMapping(funcMatch[1], userVar) : caseExpr;

    const conditions = [];
    const whenPattern = /WHEN\s+'?([^':\s]+)'?(?:::\w+)?\s+THEN\s+((?:(?!WHEN|ELSE|END).)+)/gi;

    let match;
    while ((match = whenPattern.exec(whenClauses)) !== null) {
      const value = match[1];
      const thenExpr = match[2].trim();

      if (thenExpr.toLowerCase() === 'true') {
        conditions.push(`${testExpression} === '${value}'`);
      } else if (thenExpr.toLowerCase() !== 'false') {
        const thenJs = convertToJavaScript(thenExpr, dataVar, userVar);
        conditions.push(`(${testExpression} === '${value}' && ${thenJs})`);
      }
    }

    if (elseClause && elseClause.trim().toLowerCase() !== 'false') {
      conditions.push(convertToJavaScript(elseClause.trim(), dataVar, userVar));
    }

    return conditions.length > 0 ? `(${conditions.join(' || ')})` : 'false';
  }

  /**
   * Convert to Prisma filter
   */
  function convertToPrismaFilter(sql, userVar = 'user') {
    if (!sql || sql.trim() === '') return '{}';

    sql = sql.trim().replace(/\s+/g, ' ').replace(/\n/g, ' ');

    // Handle OR conditions
    const orParts = splitLogicalOperator(sql, 'OR');
    if (orParts.length > 1) {
      const orFilters = orParts
        .map(part => convertToPrismaFilter(part, userVar))
        .filter(f => f !== '{}');

      if (orFilters.length === 0) return '{}';
      if (orFilters.length === 1) return orFilters[0];
      return `{ OR: [${orFilters.join(', ')}] }`;
    }

    // Handle AND conditions
    const andParts = splitLogicalOperator(sql, 'AND');
    if (andParts.length > 1) {
      const andFilters = andParts
        .map(part => convertToPrismaFilter(part, userVar))
        .filter(f => f !== '{}');

      if (andFilters.length === 0) return '{}';
      if (andFilters.length === 1) return andFilters[0];
      return `{ AND: [${andFilters.join(', ')}] }`;
    }

    // Skip role-only checks (they can't be filtered in Prisma)
    if (sql.match(/^\s*(?:get_current_user_role|current_user_role)\s*\(\)/i)) {
      return '{}';
    }

    // Extract field comparisons
    const filters = [];

    // Handle: field = function()
    const fieldFuncMatch = sql.match(/^(\w+)\s*=\s*(\w+)\s*\([^)]*\)$/i);
    if (fieldFuncMatch) {
      const field = fieldFuncMatch[1];
      const funcName = fieldFuncMatch[2];

      // Skip role functions
      if (funcName.toLowerCase().includes('role')) {
        return '{}';
      }

      const jsExpression = getFunctionMapping(funcName, userVar);
      return `{ ${field}: ${jsExpression} }`;
    }

    // Handle: field = (current_setting('...'))
    const settingMatch = sql.match(/^(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'([^']+)'/i);
    if (settingMatch) {
      const field = settingMatch[1];
      const setting = settingMatch[2];
      const jsExpression = getSessionMapping(setting, userVar);
      return `{ ${field}: ${jsExpression} }`;
    }

    // Handle: field = 'value' (direct comparison)
    const directMatch = sql.match(/^(\w+)\s*=\s*'([^']+)'/i);
    if (directMatch) {
      const field = directMatch[1];
      const value = directMatch[2];
      return `{ ${field}: '${value}' }`;
    }

    // Handle: field = number
    const numberMatch = sql.match(/^(\w+)\s*=\s*(\d+)$/i);
    if (numberMatch) {
      const field = numberMatch[1];
      const value = numberMatch[2];
      return `{ ${field}: ${value} }`;
    }

    // Can't convert complex conditions to Prisma filters
    return '{}';
  }

  return { convertToJavaScript, convertToPrismaFilter };
}

/**
 * Helper: Split by logical operator respecting parentheses
 */
function splitLogicalOperator(sql, operator) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inQuotes = false;
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === "'" && !inQuotes) {
      inQuotes = true;
    } else if (sql[i] === "'" && inQuotes) {
      inQuotes = false;
    } else if (!inQuotes) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      else if (depth === 0) {
        const upcoming = sql.substring(i, i + operator.length + 2);
        if (upcoming.match(new RegExp(`\\s+${operator}\\s+`, 'i'))) {
          if (current.trim()) parts.push(current.trim());
          current = '';
          i += upcoming.match(/\s+\w+\s+/)[0].length - 1;
        }
      }
    }
    current += sql[i];
    i++;
  }

  if (current.trim()) parts.push(current.trim());
  return parts.length > 1 ? parts : [sql];
}

/**
 * Helper: Extract array values
 */
function extractArrayValues(arrayContent) {
  return arrayContent
    .split(',')
    .map(r => r.trim())
    .map(r => r.replace(/::[^,\]]+/g, ''))
    .map(r => r.replace(/^'|'$/g, ''))
    .map(r => `'${r}'`)
    .join(', ');
}

module.exports = { createConverter };