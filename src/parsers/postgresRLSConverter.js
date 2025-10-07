/**
 * PostgreSQL RLS to JavaScript/Prisma Converter
 * Handles real-world PostgreSQL RLS patterns including CASE WHEN, EXISTS, type casts, etc.
 */

/**
 * Convert PostgreSQL RLS expression to JavaScript
 * @param {string} sql - PostgreSQL RLS expression
 * @param {string} dataVar - Variable name for row data
 * @param {string} userVar - Variable name for user context
 * @returns {string} - JavaScript boolean expression
 */
function convertToJavaScript(sql, dataVar = 'data', userVar = 'user') {
  if (!sql || sql.trim() === '') {
    return 'true';
  }

  sql = sql.trim();

  // Handle CASE WHEN expressions
  if (sql.toUpperCase().startsWith('CASE')) {
    return convertCaseWhen(sql, dataVar, userVar);
  }

  // Handle simple role checks: get_current_user_role() = ANY (ARRAY[...])
  const roleAnyMatch = sql.match(/get_current_user_role\(\)[^=]*=\s*ANY\s*\(\s*(?:\()?ARRAY\s*\[([^\]]+)\]/i);
  if (roleAnyMatch) {
    const roles = roleAnyMatch[1]
      .split(',')
      .map(r => r.trim())
      .map(r => r.replace(/::[^,\]]+/g, '')) // Remove type casts
      .map(r => r.replace(/^'|'$/g, '')) // Remove quotes
      .map(r => `'${r}'`)
      .join(', ');
    return `[${roles}].includes(${userVar}?.role)`;
  }

  // Handle EXISTS subqueries - these need manual implementation
  if (sql.toUpperCase().includes('EXISTS')) {
    return `true /* EXISTS subquery - requires manual implementation: ${sql.substring(0, 50)}... */`;
  }

  // Handle simple comparisons with current_setting
  const settingMatch = sql.match(/(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'/i);
  if (settingMatch) {
    const field = settingMatch[1];
    return `${dataVar}?.${field} === ${userVar}?.id`;
  }

  // Fallback: return true with comment
  return `true /* Complex RLS - manual implementation needed: ${sql.substring(0, 50)}... */`;
}

/**
 * Convert CASE WHEN expression to JavaScript
 */
function convertCaseWhen(sql, dataVar, userVar) {
  // Extract CASE conditions - improved regex to handle multiline
  const casePattern = /CASE\s+(\w+\([^)]*\))\s+(WHEN\s+[\s\S]+?)(?:ELSE\s+([\s\S]+?))?END/i;
  const match = sql.match(casePattern);

  if (!match) {
    return `false /* Unparseable CASE expression */`;
  }

  const caseExpr = match[1]; // e.g., get_current_user_role()
  const whenClauses = match[2];
  const elseClause = match[3];

  // Determine what function is being called
  let jsExpr = '';
  if (caseExpr.includes('get_current_user_role')) {
    jsExpr = `${userVar}?.role`;
  } else if (caseExpr.includes('current_user_id')) {
    jsExpr = `${userVar}?.id`;
  } else {
    return `false /* Unsupported CASE expression: ${caseExpr} */`;
  }

  // Parse WHEN clauses - improved regex for multiline THEN
  const whenPattern = /WHEN\s+'([^']+)'(?:::\w+)?\s+THEN\s+([\s\S]+?)(?=\s+WHEN\s+|$)/gi;
  const whenMatches = [...whenClauses.matchAll(whenPattern)];
  const conditions = [];

  for (const whenMatch of whenMatches) {
    const value = whenMatch[1]; // e.g., 'super_admin'
    let thenExpr = whenMatch[2].trim(); // e.g., 'true' or complex expression

    // Remove trailing text before next WHEN or ELSE
    thenExpr = thenExpr.replace(/\s+(?:WHEN|ELSE)[\s\S]*$/, '').trim();

    if (thenExpr.toLowerCase() === 'true') {
      conditions.push(`${jsExpr} === '${value}'`);
    } else {
      // Complex THEN expression - try to convert it
      const convertedThen = convertSimpleExpression(thenExpr, dataVar, userVar);
      conditions.push(`(${jsExpr} === '${value}' && ${convertedThen})`);
    }
  }

  if (conditions.length === 0) {
    return 'false';
  }

  return conditions.join(' || ');
}

/**
 * Convert simple PostgreSQL expressions
 */
function convertSimpleExpression(expr, dataVar, userVar) {
  expr = expr.trim();

  // Remove outer parentheses
  if (expr.startsWith('(') && expr.endsWith(')')) {
    expr = expr.substring(1, expr.length - 1).trim();
  }

  // Handle EXISTS - mark as needing manual implementation (check FIRST before simple patterns)
  if (expr.toUpperCase().includes('EXISTS')) {
    return `true /* EXISTS subquery requires manual implementation */`;
  }

  // Handle: id = (current_setting('app.current_user_id')::integer)
  const settingMatch = expr.match(/(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'[^)]*\)[^)]*\)/i);
  if (settingMatch) {
    const field = settingMatch[1];
    return `${dataVar}?.${field} === ${userVar}?.id`;
  }

  return 'true /* Requires manual implementation */';
}

/**
 * Convert PostgreSQL RLS expression to Prisma filter
 * @param {string} sql - PostgreSQL RLS expression
 * @param {string} userVar - Variable name for user context
 * @returns {string} - Prisma filter object as string
 */
function convertToPrismaFilter(sql, userVar = 'user') {
  if (!sql || sql.trim() === '') {
    return '{}';
  }

  sql = sql.trim();

  // Handle CASE WHEN - convert to OR filter
  if (sql.toUpperCase().startsWith('CASE')) {
    return convertCaseWhenToPrisma(sql, userVar);
  }

  // Handle simple role checks - can't filter on user role in Prisma, return empty
  const roleAnyMatch = sql.match(/get_current_user_role\(\)[^=]*=\s*ANY\s*\(\s*(?:\()?ARRAY\s*\[([^\]]+)\]/i);
  if (roleAnyMatch) {
    // Role-based access can't be filtered in Prisma - must be checked in hasAccess
    return '{}';
  }

  // Handle simple comparisons with current_setting
  const settingMatch = sql.match(/(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'/i);
  if (settingMatch) {
    const field = settingMatch[1];
    return `{ ${field}: ${userVar}?.id }`;
  }

  // Fallback
  return '{}';
}

/**
 * Convert CASE WHEN to Prisma OR filter
 */
function convertCaseWhenToPrisma(sql, userVar) {
  // For CASE WHEN expressions, extract simple field comparisons
  const settingMatches = [...sql.matchAll(/(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'/gi)];

  if (settingMatches.length > 0) {
    const filters = settingMatches.map(m => `{ ${m[1]}: ${userVar}?.id }`);
    if (filters.length === 1) {
      return filters[0];
    }
    return `{ OR: [${filters.join(', ')}] }`;
  }

  // If no simple filters found, return empty (role-based checks handled in hasAccess)
  return '{}';
}

module.exports = {
  convertToJavaScript,
  convertToPrismaFilter
};
