/**
 * Advanced PostgreSQL RLS to JavaScript/Prisma Converter
 * Handles real production PostgreSQL RLS patterns with custom functions
 */

/**
 * Main converter function - PostgreSQL RLS to JavaScript
 */
function convertToJavaScript(sql, dataVar = 'data', userVar = 'user') {
  if (!sql || sql.trim() === '') {
    return 'true';
  }

  sql = sql.trim();

  // Remove extra whitespace and newlines for consistent parsing
  sql = sql.replace(/\s+/g, ' ').replace(/\n/g, ' ');

  // Handle CASE WHEN expressions
  if (sql.toUpperCase().startsWith('CASE')) {
    return convertCaseWhen(sql, dataVar, userVar);
  }

  // Handle combined conditions with OR
  const orMatch = sql.match(/\((.*?)\)\s+OR\s+\((.*?)\)/i);
  if (orMatch) {
    const left = convertToJavaScript(orMatch[1], dataVar, userVar);
    const right = convertToJavaScript(orMatch[2], dataVar, userVar);
    return `(${left} || ${right})`;
  }

  // Handle role checks: get_current_user_role() = ANY (ARRAY[...])
  if (sql.includes('get_current_user_role')) {
    return convertRoleCheck(sql, userVar);
  }

  // Handle field comparisons with custom functions
  const customFuncPatterns = [
    { pattern: /teacher_id\s*=\s*get_current_teacher_id\(\)/i, replacement: `${dataVar}?.teacher_id === ${userVar}?.teacher_id` },
    { pattern: /student_id\s*=\s*get_current_student_id\(\)/i, replacement: `${dataVar}?.student_id === ${userVar}?.student_id` },
    { pattern: /user_id\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'[^)]*\)[^)]*\)/i, replacement: `${dataVar}?.user_id === ${userVar}?.id` },
    { pattern: /id\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'[^)]*\)[^)]*\)/i, replacement: `${dataVar}?.id === ${userVar}?.id` },
    { pattern: /(\w+)\s*=\s*get_current_teacher_id\(\)/i, replacement: (m) => `${dataVar}?.${m[1]} === ${userVar}?.teacher_id` },
    { pattern: /(\w+)\s*=\s*get_current_student_id\(\)/i, replacement: (m) => `${dataVar}?.${m[1]} === ${userVar}?.student_id` }
  ];

  for (const { pattern, replacement } of customFuncPatterns) {
    if (pattern.test(sql)) {
      if (typeof replacement === 'function') {
        const match = sql.match(pattern);
        return replacement(match);
      }
      return replacement;
    }
  }

  // Handle EXISTS subqueries
  if (sql.includes('EXISTS')) {
    return convertExistsSubquery(sql, dataVar, userVar);
  }

  // Fallback for unhandled patterns
  return `true /* Complex RLS expression: ${sql.substring(0, 80)}... */`;
}

/**
 * Convert role check expressions
 */
function convertRoleCheck(sql, userVar) {
  // Extract roles from ARRAY[...] pattern
  const arrayMatch = sql.match(/ARRAY\s*\[([^\]]+)\]/i);
  if (arrayMatch) {
    const roles = arrayMatch[1]
      .split(',')
      .map(r => r.trim())
      .map(r => r.replace(/::[^,\]]+/g, '')) // Remove type casts (including "character varying")
      .map(r => r.replace(/^'|'$/g, '')) // Remove quotes
      .map(r => `'${r}'`)
      .join(', ');
    return `[${roles}].includes(${userVar}?.role)`;
  }

  // Simple role equality
  const simpleMatch = sql.match(/get_current_user_role\(\)[^=]*=\s*'([^']+)'/i);
  if (simpleMatch) {
    return `${userVar}?.role === '${simpleMatch[1]}'`;
  }

  return `true /* Unparseable role check */`;
}

/**
 * Convert CASE WHEN expressions
 */
function convertCaseWhen(sql, dataVar, userVar) {
  // Extract the CASE expression and branches
  const caseMatch = sql.match(/CASE\s+(\S+(?:\([^)]*\))?)\s+((?:WHEN[\s\S]+?)+)\s*(?:ELSE\s+([\s\S]+?))?\s*END/i);

  if (!caseMatch) {
    return `false /* Unparseable CASE expression */`;
  }

  const caseExpr = caseMatch[1];
  const whenClauses = caseMatch[2];
  const elseClause = caseMatch[3];

  // Determine what's being tested
  let testExpr = '';
  if (caseExpr.includes('get_current_user_role')) {
    testExpr = `${userVar}?.role`;
  } else if (caseExpr.includes('get_current_teacher_id')) {
    testExpr = `${userVar}?.teacher_id`;
  } else if (caseExpr.includes('get_current_student_id')) {
    testExpr = `${userVar}?.student_id`;
  } else {
    return `false /* Unsupported CASE expression: ${caseExpr} */`;
  }

  // Parse WHEN branches
  const whenPattern = /WHEN\s+'?([^':\s]+)'?(?:::\w+)?\s+THEN\s+((?:(?!WHEN\s+|ELSE\s+|END).)+)/gi;
  const conditions = [];

  let match;
  while ((match = whenPattern.exec(whenClauses)) !== null) {
    const value = match[1];
    const thenExpr = match[2].trim();

    if (thenExpr.toLowerCase() === 'true') {
      conditions.push(`${testExpr} === '${value}'`);
    } else if (thenExpr.toLowerCase() === 'false') {
      // Skip false conditions
    } else {
      // Complex THEN expression
      const convertedThen = convertThenExpression(thenExpr, dataVar, userVar);
      if (convertedThen !== 'false') {
        conditions.push(`(${testExpr} === '${value}' && ${convertedThen})`);
      }
    }
  }

  // Handle ELSE clause
  if (elseClause && elseClause.trim().toLowerCase() === 'true') {
    conditions.push('true');
  }

  return conditions.length > 0 ? conditions.join(' || ') : 'false';
}

/**
 * Convert THEN expressions in CASE WHEN
 */
function convertThenExpression(expr, dataVar, userVar) {
  expr = expr.trim();

  // Remove parentheses
  if (expr.startsWith('(') && expr.endsWith(')')) {
    expr = expr.substring(1, expr.length - 1).trim();
  }

  // Handle EXISTS
  if (expr.includes('EXISTS')) {
    return convertExistsSubquery(expr, dataVar, userVar);
  }

  // Handle field = function() patterns
  const patterns = [
    { regex: /teacher_id\s*=\s*get_current_teacher_id\(\)/i, js: `${dataVar}?.teacher_id === ${userVar}?.teacher_id` },
    { regex: /student_id\s*=\s*get_current_student_id\(\)/i, js: `${dataVar}?.student_id === ${userVar}?.student_id` },
    { regex: /id\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'[^)]*\)[^)]*\)/i, js: `${dataVar}?.id === ${userVar}?.id` },
    { regex: /(\w+)\s*=\s*get_current_(\w+)_id\(\)/i, handler: (m) => `${dataVar}?.${m[1]} === ${userVar}?.${m[2]}_id` }
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(expr)) {
      if (pattern.handler) {
        const match = expr.match(pattern.regex);
        return pattern.handler(match);
      }
      return pattern.js;
    }
  }

  return 'true';
}

/**
 * Convert EXISTS subqueries to JavaScript
 * These typically check relationships between tables
 */
function convertExistsSubquery(sql, dataVar, userVar) {
  // Common patterns in EXISTS subqueries

  // Pattern 1: Check if student_tariff belongs to current student
  if (sql.includes('student_tariff') && sql.includes('get_current_student_id')) {
    return `true /* TODO: Check if ${dataVar}?.student_tariff.student_id === ${userVar}?.student_id */`;
  }

  // Pattern 2: Check if teacher has access
  if (sql.includes('get_current_teacher_id')) {
    return `true /* TODO: Check if ${dataVar} is accessible to teacher ${userVar}?.teacher_id */`;
  }

  // Pattern 3: Check user address relationships
  if (sql.includes('contact_address_id') || sql.includes('billing_address_id')) {
    return `true /* TODO: Check if address belongs to user via contact_address_id or billing_address_id */`;
  }

  // Pattern 4: Generic student access check
  if (sql.includes('student') && sql.includes('get_current_student_id')) {
    return `true /* TODO: Check student relationship */`;
  }

  // Default EXISTS handling
  return `true /* EXISTS subquery requires manual implementation */`;
}

/**
 * Convert to Prisma filter
 */
function convertToPrismaFilter(sql, userVar = 'user') {
  if (!sql || sql.trim() === '') {
    return '{}';
  }

  sql = sql.trim().replace(/\s+/g, ' ').replace(/\n/g, ' ');

  // Role-based filters can't be directly applied in Prisma WHERE clause
  if (sql.includes('get_current_user_role')) {
    return '{}'; // Role checks are done in hasAccess, not in filter
  }

  // Handle CASE WHEN - extract filterable conditions
  if (sql.toUpperCase().startsWith('CASE')) {
    return convertCaseWhenToPrisma(sql, userVar);
  }

  // Handle simple field comparisons
  const patterns = [
    { regex: /teacher_id\s*=\s*get_current_teacher_id\(\)/i, filter: `{ teacher_id: ${userVar}?.teacher_id }` },
    { regex: /student_id\s*=\s*get_current_student_id\(\)/i, filter: `{ student_id: ${userVar}?.student_id }` },
    { regex: /user_id\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'/i, filter: `{ user_id: ${userVar}?.id }` },
    { regex: /^id\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'/i, filter: `{ id: ${userVar}?.id }` }
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(sql)) {
      return pattern.filter;
    }
  }

  // Handle OR conditions
  const orMatch = sql.match(/\((.*?)\)\s+OR\s+\((.*?)\)/i);
  if (orMatch) {
    const left = convertToPrismaFilter(orMatch[1], userVar);
    const right = convertToPrismaFilter(orMatch[2], userVar);
    if (left !== '{}' && right !== '{}') {
      return `{ OR: [${left}, ${right}] }`;
    } else if (left !== '{}') {
      return left;
    } else if (right !== '{}') {
      return right;
    }
  }

  return '{}';
}

/**
 * Convert CASE WHEN to Prisma filter
 */
function convertCaseWhenToPrisma(sql, userVar) {
  // Extract field-based conditions that can be filtered in Prisma
  const filters = [];

  // Look for teacher_id = get_current_teacher_id()
  if (sql.includes('teacher_id') && sql.includes('get_current_teacher_id')) {
    filters.push(`{ teacher_id: ${userVar}?.teacher_id }`);
  }

  // Look for student_id = get_current_student_id()
  if (sql.includes('student_id') && sql.includes('get_current_student_id')) {
    filters.push(`{ student_id: ${userVar}?.student_id }`);
  }

  // Look for id = current_setting('app.current_user_id')
  if (sql.match(/id\s*=\s*\(\s*current_setting\s*\(\s*'app\.current_user_id'/i)) {
    filters.push(`{ id: ${userVar}?.id }`);
  }

  if (filters.length === 0) {
    return '{}';
  }

  if (filters.length === 1) {
    return filters[0];
  }

  // Multiple conditions are OR'd in CASE WHEN
  return `{ OR: [${filters.join(', ')}] }`;
}

module.exports = {
  convertToJavaScript,
  convertToPrismaFilter
};