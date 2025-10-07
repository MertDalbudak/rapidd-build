/**
 * SQL to JavaScript/Prisma Filter Converter
 * Converts PostgreSQL RLS policy expressions to JavaScript and Prisma filters
 */

/**
 * Parse SQL expression into an AST (Abstract Syntax Tree)
 * @param {string} sql - SQL expression
 * @returns {Object} - Parsed AST
 */
function parseSqlExpression(sql) {
  if (!sql) return null;

  // Clean up the SQL
  sql = sql.trim();

  // Handle parentheses and logical operators
  return parseLogicalExpression(sql);
}

/**
 * Parse logical expressions (AND, OR)
 * @param {string} sql - SQL expression
 * @returns {Object} - AST node
 */
function parseLogicalExpression(sql) {
  // Find top-level OR (lowest precedence)
  const orParts = splitByOperator(sql, 'OR');
  if (orParts.length > 1) {
    return {
      type: 'OR',
      operands: orParts.map(part => parseLogicalExpression(part))
    };
  }

  // Find top-level AND (higher precedence than OR)
  const andParts = splitByOperator(sql, 'AND');
  if (andParts.length > 1) {
    return {
      type: 'AND',
      operands: andParts.map(part => parseLogicalExpression(part))
    };
  }

  // Parse comparison or other expressions
  return parseComparisonExpression(sql);
}

/**
 * Split SQL by operator at the same nesting level
 * @param {string} sql - SQL expression
 * @param {string} operator - Operator to split by (AND, OR)
 * @returns {Array} - Parts split by operator
 */
function splitByOperator(sql, operator) {
  const parts = [];
  let current = '';
  let depth = 0;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];

    if (char === '(') {
      depth++;
      current += char;
      i++;
    } else if (char === ')') {
      depth--;
      current += char;
      i++;
    } else if (depth === 0) {
      // Check if we're at the operator
      const remaining = sql.substring(i);
      const operatorPattern = new RegExp(`^\\s+${operator}\\s+`, 'i');
      const match = remaining.match(operatorPattern);

      if (match) {
        parts.push(current.trim());
        current = '';
        i += match[0].length;
      } else {
        current += char;
        i++;
      }
    } else {
      current += char;
      i++;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.length > 0 ? parts : [sql];
}

/**
 * Parse comparison expressions
 * @param {string} sql - SQL expression
 * @returns {Object} - AST node
 */
function parseComparisonExpression(sql) {
  sql = sql.trim();

  // Remove outer parentheses
  if (sql.startsWith('(') && sql.endsWith(')')) {
    const inner = sql.substring(1, sql.length - 1);
    // Make sure these are matching parentheses
    if (countParentheses(inner) === 0) {
      return parseLogicalExpression(inner);
    }
  }

  // Handle NOT
  if (sql.toUpperCase().startsWith('NOT ')) {
    return {
      type: 'NOT',
      operand: parseLogicalExpression(sql.substring(4).trim())
    };
  }

  // Handle = ANY (ARRAY[...]) pattern (PostgreSQL specific)
  const anyArrayMatch = sql.match(/^(.+?)\s*=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]+)\]\s*\)/i);
  if (anyArrayMatch) {
    const left = anyArrayMatch[1].trim();
    const arrayItems = anyArrayMatch[2].split(',').map(item => item.trim());
    return {
      type: 'COMPARISON',
      operator: 'IN',
      left: parseValue(left),
      right: {
        type: 'ARRAY',
        items: arrayItems.map(item => parseValue(item))
      }
    };
  }

  // Handle IN (SELECT...) - mark as subquery
  const inSelectMatch = sql.match(/^(.+?)\s+IN\s+\(SELECT/i);
  if (inSelectMatch) {
    return {
      type: 'COMPARISON',
      operator: 'IN',
      left: parseValue(inSelectMatch[1].trim()),
      right: { type: 'SUBQUERY', value: '/* Subquery - needs manual implementation */' }
    };
  }

  // Parse comparison operators
  const comparisonOps = ['<=', '>=', '<>', '!=', '=', '<', '>', ' IN ', ' NOT IN ', ' LIKE ', ' ILIKE ', ' IS NULL', ' IS NOT NULL'];

  for (const op of comparisonOps) {
    const index = findOperatorIndex(sql, op);
    if (index !== -1) {
      const left = sql.substring(0, index).trim();
      const right = sql.substring(index + op.length).trim();

      return {
        type: 'COMPARISON',
        operator: op.trim(),
        left: parseValue(left),
        right: op.trim().includes('IS') ? null : parseValue(right)
      };
    }
  }

  // If no operator found, treat as a value
  return parseValue(sql);
}

/**
 * Find operator index outside of parentheses and quotes
 * @param {string} sql - SQL expression
 * @param {string} operator - Operator to find
 * @returns {number} - Index or -1
 */
function findOperatorIndex(sql, operator) {
  const upperSql = sql.toUpperCase();
  const upperOp = operator.toUpperCase();
  let depth = 0;
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if ((char === "'" || char === '"') && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (!inQuotes) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (depth === 0 && upperSql.substring(i, i + upperOp.length) === upperOp) {
        // Check word boundaries for operators like IN
        if (upperOp.startsWith(' ')) {
          return i;
        }
        // For symbols like =, <, > etc
        if (i === 0 || !isAlphanumeric(sql[i - 1])) {
          return i;
        }
      }
    }
  }

  return -1;
}

/**
 * Parse a value (column, literal, function call, etc.)
 * @param {string} value - Value string
 * @returns {Object} - Parsed value
 */
function parseValue(value) {
  value = value.trim();

  // Strip PostgreSQL type casts (e.g., 'admin'::user_role -> 'admin')
  const typeCastMatch = value.match(/^(.+)::[\w_]+$/);
  if (typeCastMatch) {
    value = typeCastMatch[1].trim();
  }

  // Handle NULL
  if (value.toUpperCase() === 'NULL') {
    return { type: 'NULL' };
  }

  // Handle boolean literals
  if (value.toUpperCase() === 'TRUE') {
    return { type: 'BOOLEAN', value: true };
  }
  if (value.toUpperCase() === 'FALSE') {
    return { type: 'BOOLEAN', value: false };
  }

  // Handle string literals
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return {
      type: 'STRING',
      value: value.substring(1, value.length - 1)
    };
  }

  // Handle numbers
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return {
      type: 'NUMBER',
      value: parseFloat(value)
    };
  }

  // Handle array literals (for IN operator)
  if (value.startsWith('(') && value.endsWith(')')) {
    const inner = value.substring(1, value.length - 1);
    const items = inner.split(',').map(item => parseValue(item.trim()));
    return {
      type: 'ARRAY',
      items: items
    };
  }

  // Handle function calls
  const funcMatch = value.match(/^(\w+)\((.*)\)$/);
  if (funcMatch) {
    return {
      type: 'FUNCTION',
      name: funcMatch[1],
      args: funcMatch[2] ? funcMatch[2].split(',').map(arg => parseValue(arg.trim())) : []
    };
  }

  // Handle column references (including table.column)
  if (/^[\w.]+$/.test(value)) {
    const parts = value.split('.');
    if (parts.length === 2) {
      return {
        type: 'COLUMN',
        table: parts[0],
        column: parts[1]
      };
    }
    return {
      type: 'COLUMN',
      column: value
    };
  }

  // Unknown - return as raw
  return {
    type: 'RAW',
    value: value
  };
}

/**
 * Count unmatched parentheses
 */
function countParentheses(str) {
  let count = 0;
  for (const char of str) {
    if (char === '(') count++;
    if (char === ')') count--;
  }
  return count;
}

/**
 * Check if character is alphanumeric
 */
function isAlphanumeric(char) {
  return /[a-zA-Z0-9_]/.test(char);
}

/**
 * Convert AST to JavaScript boolean expression
 * @param {Object} ast - Abstract syntax tree
 * @param {string} dataVar - Variable name for data object (e.g., 'data', 'user')
 * @param {string} userVar - Variable name for user object
 * @returns {string} - JavaScript expression
 */
function astToJavaScript(ast, dataVar = 'data', userVar = 'user') {
  if (!ast) return 'true';

  switch (ast.type) {
    case 'OR':
      return '(' + ast.operands.map(op => astToJavaScript(op, dataVar, userVar)).join(' || ') + ')';

    case 'AND':
      return '(' + ast.operands.map(op => astToJavaScript(op, dataVar, userVar)).join(' && ') + ')';

    case 'NOT':
      return '!(' + astToJavaScript(ast.operand, dataVar, userVar) + ')';

    case 'COMPARISON':
      return convertComparisonToJS(ast, dataVar, userVar);

    case 'COLUMN':
      return valueToJS(ast, dataVar, userVar);

    case 'BOOLEAN':
      return ast.value.toString();

    default:
      return 'true';
  }
}

/**
 * Convert comparison to JavaScript
 */
function convertComparisonToJS(ast, dataVar, userVar) {
  const left = valueToJS(ast.left, dataVar, userVar);
  const right = ast.right ? valueToJS(ast.right, dataVar, userVar) : null;

  switch (ast.operator.toUpperCase()) {
    case '=':
      return `${left} === ${right}`;
    case '!=':
    case '<>':
      return `${left} !== ${right}`;
    case '<':
      return `${left} < ${right}`;
    case '>':
      return `${left} > ${right}`;
    case '<=':
      return `${left} <= ${right}`;
    case '>=':
      return `${left} >= ${right}`;
    case 'IN':
      if (ast.right.type === 'ARRAY') {
        const items = ast.right.items.map(item => valueToJS(item, dataVar, userVar)).join(', ');
        return `[${items}].includes(${left})`;
      }
      return `${right}.includes(${left})`;
    case 'NOT IN':
      if (ast.right.type === 'ARRAY') {
        const items = ast.right.items.map(item => valueToJS(item, dataVar, userVar)).join(', ');
        return `![${items}].includes(${left})`;
      }
      return `!${right}.includes(${left})`;
    case 'IS NULL':
      return `${left} == null`;
    case 'IS NOT NULL':
      return `${left} != null`;
    case 'LIKE':
    case 'ILIKE':
      // Convert SQL LIKE to JavaScript regex
      return `${left}?.toString().match(/${sqlLikeToRegex(ast.right.value)}/${ast.operator === 'ILIKE' ? 'i' : ''}) != null`;
    default:
      return 'true';
  }
}

/**
 * Convert value to JavaScript
 */
function valueToJS(ast, dataVar, userVar) {
  if (!ast) return 'null';

  switch (ast.type) {
    case 'COLUMN':
      // Map PostgreSQL special columns
      const column = ast.column.toLowerCase();
      if (column === 'current_user' || column === 'session_user' || column === 'user') {
        return `${userVar}?.id`;
      }
      // Regular column reference
      if (ast.table) {
        return `${dataVar}?.${ast.column}`;
      }
      return `${dataVar}?.${ast.column}`;

    case 'STRING':
      return `'${ast.value.replace(/'/g, "\\'")}'`;

    case 'NUMBER':
      return ast.value.toString();

    case 'BOOLEAN':
      return ast.value.toString();

    case 'NULL':
      return 'null';

    case 'FUNCTION':
      return convertFunctionToJS(ast, dataVar, userVar);

    case 'ARRAY':
      return '[' + ast.items.map(item => valueToJS(item, dataVar, userVar)).join(', ') + ']';

    case 'SUBQUERY':
      // Subqueries can't be directly converted to JavaScript
      return '[]';

    default:
      return 'null';
  }
}

/**
 * Convert PostgreSQL function to JavaScript
 */
function convertFunctionToJS(ast, dataVar, userVar) {
  const funcName = ast.name.toLowerCase();

  switch (funcName) {
    case 'current_user':
    case 'session_user':
      return `${userVar}?.id`;
    case 'current_user_id':
      // Custom function: current_user_id() -> user?.id
      return `${userVar}?.id`;
    case 'current_user_role':
      // Custom function: current_user_role() -> user?.role
      return `${userVar}?.role`;
    case 'current_setting':
      // current_setting('app.current_user_id') -> user?.id
      return `${userVar}?.id`;
    case 'auth':
      // auth.uid() -> user?.id (Supabase style)
      if (ast.args[0]?.value === 'uid') {
        return `${userVar}?.id`;
      }
      return `${userVar}?.id`;
    default:
      return 'null';
  }
}

/**
 * Convert SQL LIKE pattern to regex
 */
function sqlLikeToRegex(pattern) {
  return pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .replace(/%/g, '.*') // % becomes .*
    .replace(/_/g, '.'); // _ becomes .
}

/**
 * Convert AST to Prisma filter object
 * @param {Object} ast - Abstract syntax tree
 * @param {string} userVar - Variable name for user object
 * @returns {string} - JavaScript code that returns Prisma filter
 */
function astToPrismaFilter(ast, userVar = 'user') {
  if (!ast) return '{}';

  switch (ast.type) {
    case 'OR':
      const orFilters = ast.operands.map(op => astToPrismaFilter(op, userVar));
      return `{ OR: [${orFilters.join(', ')}] }`;

    case 'AND':
      const andFilters = ast.operands.map(op => astToPrismaFilter(op, userVar));
      return `{ AND: [${andFilters.join(', ')}] }`;

    case 'NOT':
      return `{ NOT: ${astToPrismaFilter(ast.operand, userVar)} }`;

    case 'COMPARISON':
      return convertComparisonToPrisma(ast, userVar);

    default:
      return '{}';
  }
}

/**
 * Convert comparison to Prisma filter
 */
function convertComparisonToPrisma(ast, userVar) {
  if (ast.left.type !== 'COLUMN') return '{}';

  const column = ast.left.column;
  const rightValue = valueToPrisma(ast.right, userVar);

  switch (ast.operator.toUpperCase()) {
    case '=':
      return `{ ${column}: ${rightValue} }`;
    case '!=':
    case '<>':
      return `{ ${column}: { not: ${rightValue} } }`;
    case '<':
      return `{ ${column}: { lt: ${rightValue} } }`;
    case '>':
      return `{ ${column}: { gt: ${rightValue} } }`;
    case '<=':
      return `{ ${column}: { lte: ${rightValue} } }`;
    case '>=':
      return `{ ${column}: { gte: ${rightValue} } }`;
    case 'IN':
      if (ast.right.type === 'ARRAY') {
        const items = ast.right.items.map(item => valueToPrisma(item, userVar)).join(', ');
        return `{ ${column}: { in: [${items}] } }`;
      }
      return `{ ${column}: { in: ${rightValue} } }`;
    case 'NOT IN':
      if (ast.right.type === 'ARRAY') {
        const items = ast.right.items.map(item => valueToPrisma(item, userVar)).join(', ');
        return `{ ${column}: { notIn: [${items}] } }`;
      }
      return `{ ${column}: { notIn: ${rightValue} } }`;
    case 'IS NULL':
      return `{ ${column}: null }`;
    case 'IS NOT NULL':
      return `{ ${column}: { not: null } }`;
    case 'LIKE':
    case 'ILIKE':
      return `{ ${column}: { contains: ${rightValue}, mode: '${ast.operator === 'ILIKE' ? 'insensitive' : 'default'}' } }`;
    default:
      return '{}';
  }
}

/**
 * Convert value to Prisma-compatible value
 */
function valueToPrisma(ast, userVar) {
  if (!ast) return 'null';

  switch (ast.type) {
    case 'COLUMN':
      const column = ast.column.toLowerCase();
      if (column === 'current_user' || column === 'session_user' || column === 'user') {
        return `${userVar}?.id`;
      }
      return `${userVar}?.${ast.column}`;

    case 'STRING':
      return `'${ast.value.replace(/'/g, "\\'")}'`;

    case 'NUMBER':
      return ast.value.toString();

    case 'BOOLEAN':
      return ast.value.toString();

    case 'NULL':
      return 'null';

    case 'FUNCTION':
      const funcName = ast.name.toLowerCase();
      if (funcName === 'current_user' || funcName === 'session_user' || funcName === 'current_user_id') {
        return `${userVar}?.id`;
      }
      if (funcName === 'current_user_role') {
        return `${userVar}?.role`;
      }
      return `${userVar}?.id`;

    case 'SUBQUERY':
      // Subqueries can't be directly converted to Prisma
      return '[]';

    default:
      return 'null';
  }
}

module.exports = {
  parseSqlExpression,
  astToJavaScript,
  astToPrismaFilter
};
