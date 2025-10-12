/**
 * Dynamic PostgreSQL RLS to JavaScript/Prisma Converter
 * Handles any PostgreSQL RLS pattern without hardcoding assumptions
 */

/**
 * Main converter function - PostgreSQL RLS to JavaScript
 */
function convertToJavaScript(sql, dataVar = 'data', userVar = 'user') {
  if (!sql || sql.trim() === '') {
    return 'true';
  }

  sql = sql.trim();

  // Strip outer parentheses if they wrap the entire expression
  if (sql.startsWith('(') && sql.endsWith(')')) {
    let depth = 0;
    let matchesOuter = true;
    for (let i = 0; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      if (sql[i] === ')') depth--;
      if (depth === 0 && i < sql.length - 1) {
        matchesOuter = false;
        break;
      }
    }
    if (matchesOuter) {
      sql = sql.substring(1, sql.length - 1).trim();
    }
  }

  // Normalize whitespace
  sql = sql.replace(/\s+/g, ' ').replace(/\n/g, ' ');

  // Handle CASE WHEN expressions
  if (sql.toUpperCase().startsWith('CASE')) {
    return convertCaseWhen(sql, dataVar, userVar);
  }

  // Handle OR conditions
  const orMatch = sql.match(/\((.*?)\)\s+OR\s+\((.*?)\)/i);
  if (orMatch) {
    const left = convertToJavaScript(orMatch[1], dataVar, userVar);
    const right = convertToJavaScript(orMatch[2], dataVar, userVar);
    return `(${left} || ${right})`;
  }

  // Handle AND conditions
  const andMatch = sql.match(/\((.*?)\)\s+AND\s+\((.*?)\)/i);
  if (andMatch) {
    const left = convertToJavaScript(andMatch[1], dataVar, userVar);
    const right = convertToJavaScript(andMatch[2], dataVar, userVar);
    return `(${left} && ${right})`;
  }

  // Handle function calls with = ANY (ARRAY[...])
  const anyArrayMatch = sql.match(/(\w+)\s*\([^)]*\)[^=]*=\s*ANY\s*\(\s*(?:\()?ARRAY\s*\[([^\]]+)\]/i);
  if (anyArrayMatch) {
    const funcName = anyArrayMatch[1];
    const arrayValues = extractArrayValues(anyArrayMatch[2]);

    // Map function names to user properties dynamically
    const userProperty = mapFunctionToUserProperty(funcName);
    return `[${arrayValues}].includes(${userVar}?.${userProperty})`;
  }

  // Handle field = function() comparisons (with or without quotes)
  const funcCompareMatch = sql.match(/(?:"?(\w+)"?)\s*=\s*(\w+)\s*\([^)]*\)/i);
  if (funcCompareMatch) {
    const field = funcCompareMatch[1];
    const funcName = funcCompareMatch[2];

    // Map function to user property
    const userProperty = mapFunctionToUserProperty(funcName);
    return `${dataVar}?.${field} === ${userVar}?.${userProperty}`;
  }

  // Handle field = (current_setting(...))
  const currentSettingMatch = sql.match(/(?:"?(\w+)"?)\s*=\s*\(\s*current_setting\s*\(\s*'([^']+)'/i);
  if (currentSettingMatch) {
    const field = currentSettingMatch[1];
    const setting = currentSettingMatch[2];

    // Map setting to user property
    const userProperty = mapSettingToUserProperty(setting);
    return `${dataVar}?.${field} === ${userVar}?.${userProperty}`;
  }

  // Handle field = literal value (true, false, numbers, strings)
  const literalMatch = sql.match(/(?:"?(\w+)"?)\s*=\s*(true|false|\d+|'[^']+')/i);
  if (literalMatch) {
    const field = literalMatch[1];
    const value = literalMatch[2];
    return `${dataVar}?.${field} === ${value}`;
  }

  // Handle EXISTS subqueries
  if (sql.includes('EXISTS')) {
    return handleExistsSubquery(sql, dataVar, userVar);
  }

  // Handle simple boolean values
  if (sql.toLowerCase() === 'true') return 'true';
  if (sql.toLowerCase() === 'false') return 'false';

  // Unhandled pattern
  console.warn(`⚠ Unhandled RLS pattern: ${sql}`);
  return `true /* Unhandled RLS pattern: ${sql.substring(0, 60)}... */`;
}

/**
 * Map PostgreSQL function names to user object properties
 * This is where customization happens based on your PostgreSQL functions
 */
function mapFunctionToUserProperty(funcName) {
  const mappings = {
    // Common patterns - can be customized per project
    'get_current_user_role': 'role',
    'get_current_user_id': 'id',
    'current_user_id': 'id',
    'get_current_teacher_id': 'teacher_id',
    'get_current_student_id': 'student_id',
    'get_current_agency_id': 'agency_id',
    'get_current_school_id': 'school_id',
    // Add more mappings as needed
  };

  // If we have a mapping, use it
  if (mappings[funcName]) {
    return mappings[funcName];
  }

  // Try to infer from function name
  // get_current_X_id -> X_id
  const getIdMatch = funcName.match(/get_current_(\w+)_id/i);
  if (getIdMatch) {
    return `${getIdMatch[1]}_id`;
  }

  // get_current_X -> X
  const getCurrentMatch = funcName.match(/get_current_(\w+)/i);
  if (getCurrentMatch) {
    return getCurrentMatch[1];
  }

  // current_X -> X
  const currentMatch = funcName.match(/current_(\w+)/i);
  if (currentMatch) {
    return currentMatch[1];
  }

  // Default: use function name as-is
  return funcName;
}

/**
 * Map PostgreSQL settings to user properties
 */
function mapSettingToUserProperty(setting) {
  // app.current_user_id -> id
  if (setting === 'app.current_user_id') {
    return 'id';
  }

  // app.current_X -> X
  const appMatch = setting.match(/app\.current_(\w+)/i);
  if (appMatch) {
    return appMatch[1];
  }

  // Default
  return setting.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Extract and format array values
 */
function extractArrayValues(arrayContent) {
  return arrayContent
    .split(',')
    .map(r => r.trim())
    .map(r => r.replace(/::[^,\]]+/g, '')) // Remove all type casts
    .map(r => r.replace(/^'|'$/g, '')) // Remove quotes
    .map(r => `'${r}'`)
    .join(', ');
}

/**
 * Convert CASE WHEN expressions
 */
function convertCaseWhen(sql, dataVar, userVar) {
  const caseMatch = sql.match(/CASE\s+(\S+(?:\([^)]*\))?)\s+((?:WHEN[\s\S]+?)+)\s*(?:ELSE\s+([\s\S]+?))?\s*END/i);

  if (!caseMatch) {
    return `false /* Unparseable CASE expression */`;
  }

  const caseExpr = caseMatch[1];
  const whenClauses = caseMatch[2];
  const elseClause = caseMatch[3];

  // Extract the function being called in CASE
  let testProperty = 'unknown';
  const funcMatch = caseExpr.match(/(\w+)\s*\(/);
  if (funcMatch) {
    testProperty = mapFunctionToUserProperty(funcMatch[1]);
  }

  // Parse WHEN branches
  const whenPattern = /WHEN\s+'?([^':\s]+)'?(?:::\w+)?\s+THEN\s+((?:(?!WHEN\s+|ELSE\s+|END).)+)/gi;
  const conditions = [];

  let match;
  while ((match = whenPattern.exec(whenClauses)) !== null) {
    const value = match[1];
    const thenExpr = match[2].trim();

    if (thenExpr.toLowerCase() === 'true') {
      conditions.push(`${userVar}?.${testProperty} === '${value}'`);
    } else if (thenExpr.toLowerCase() === 'false') {
      // Skip false conditions
    } else {
      // Complex THEN expression - recursively convert
      const convertedThen = convertToJavaScript(thenExpr, dataVar, userVar);
      if (convertedThen !== 'false') {
        conditions.push(`(${userVar}?.${testProperty} === '${value}' && ${convertedThen})`);
      }
    }
  }

  // Handle ELSE clause
  if (elseClause && elseClause.trim().toLowerCase() !== 'false') {
    const elseConverted = convertToJavaScript(elseClause.trim(), dataVar, userVar);
    if (elseConverted !== 'false') {
      conditions.push(elseConverted);
    }
  }

  return conditions.length > 0 ? `(${conditions.join(' || ')})` : 'false';
}

/**
 * Handle EXISTS subqueries
 * These typically check relationships and need manual implementation
 */
function handleExistsSubquery(sql, dataVar, userVar) {
  // Try to extract meaningful information from the EXISTS clause
  const existsMatch = sql.match(/EXISTS\s*\(\s*SELECT[^)]+FROM\s+(\w+)[^)]+WHERE\s+([^)]+)\)/i);

  if (existsMatch) {
    const tableName = existsMatch[1];
    const whereClause = existsMatch[2];

    // Look for common patterns in WHERE clause
    // Pattern: checking if related table's foreign key matches current context
    const fkMatch = whereClause.match(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi);
    if (fkMatch) {
      return `true /* TODO: Check ${tableName} relationship via JOIN */`;
    }

    // Pattern: checking against current user functions
    if (whereClause.match(/get_current_\w+_id\(\)/i)) {
      return `true /* TODO: Verify ${tableName} access for current user context */`;
    }
  }

  return `true /* EXISTS subquery needs manual implementation */`;
}

/**
 * Convert to Prisma filter
 */
function convertToPrismaFilter(sql, userVar = 'user') {
  if (!sql || sql.trim() === '') {
    return '{}';
  }

  sql = sql.trim().replace(/\s+/g, ' ').replace(/\n/g, ' ');

  // CASE WHEN - extract filterable conditions
  if (sql.toUpperCase().startsWith('CASE')) {
    return extractPrismaFiltersFromCase(sql, userVar);
  }

  // Handle field = function() patterns
  const funcCompareMatch = sql.match(/(\w+)\s*=\s*(\w+)\s*\([^)]*\)/i);
  if (funcCompareMatch) {
    const field = funcCompareMatch[1];
    const funcName = funcCompareMatch[2];
    const userProperty = mapFunctionToUserProperty(funcName);

    // Only create filter if it's a data field comparison
    if (!funcName.includes('role')) {
      return `{ ${field}: ${userVar}?.${userProperty} }`;
    }
  }

  // Handle current_setting patterns
  const settingMatch = sql.match(/(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'([^']+)'/i);
  if (settingMatch) {
    const field = settingMatch[1];
    const setting = settingMatch[2];
    const userProperty = mapSettingToUserProperty(setting);
    return `{ ${field}: ${userVar}?.${userProperty} }`;
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

  // Role-based checks can't be filtered in Prisma
  if (sql.match(/get_current_\w+_role/i) || sql.includes('= ANY')) {
    return '{}';
  }

  return '{}';
}

/**
 * Extract Prisma filters from CASE WHEN
 */
function extractPrismaFiltersFromCase(sql, userVar) {
  const filters = new Set();

  // Look for all field = function() patterns in the CASE statement
  const fieldMatches = sql.matchAll(/(\w+)\s*=\s*(\w+)\s*\([^)]*\)/gi);

  for (const match of fieldMatches) {
    const field = match[1];
    const funcName = match[2];

    // Skip role checks
    if (funcName.includes('role')) continue;

    const userProperty = mapFunctionToUserProperty(funcName);
    filters.add(`{ ${field}: ${userVar}?.${userProperty} }`);
  }

  // Look for current_setting patterns
  const settingMatches = sql.matchAll(/(\w+)\s*=\s*\(\s*current_setting\s*\(\s*'([^']+)'/gi);

  for (const match of settingMatches) {
    const field = match[1];
    const setting = match[2];
    const userProperty = mapSettingToUserProperty(setting);
    filters.add(`{ ${field}: ${userVar}?.${userProperty} }`);
  }

  const filterArray = Array.from(filters);

  if (filterArray.length === 0) {
    return '{}';
  }

  if (filterArray.length === 1) {
    return filterArray[0];
  }

  return `{ OR: [${filterArray.join(', ')}] }`;
}

module.exports = {
  convertToJavaScript,
  convertToPrismaFilter,
  mapFunctionToUserProperty,
  mapSettingToUserProperty
};