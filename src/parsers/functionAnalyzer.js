/**
 * PostgreSQL Function Analyzer
 * Dynamically analyzes PostgreSQL functions and generates JavaScript mappings
 */

const { Client } = require('pg');

/**
 * Analyze all PostgreSQL functions used in RLS policies
 * @param {string} databaseUrl - PostgreSQL connection URL
 * @returns {Object} - Function mappings and metadata
 */
async function analyzeFunctions(databaseUrl) {
  if (!databaseUrl) {
    return {
      functionMappings: {},
      sessionVariables: [],
      userContextRequirements: {}
    };
  }

  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();

    // Step 1: Find all functions used in RLS policies
    const functionsQuery = await client.query(`
      WITH rls_text AS (
        SELECT
          qual || ' ' || COALESCE(with_check, '') as policy_text
        FROM pg_policies
        WHERE schemaname = 'public'
      ),
      function_names AS (
        SELECT DISTINCT
          unnest(
            regexp_matches(
              policy_text,
              '(\\w+)\\s*\\(',
              'g'
            )
          ) as function_name
        FROM rls_text
      )
      SELECT function_name
      FROM function_names
      WHERE function_name NOT IN ('SELECT', 'EXISTS', 'ANY', 'ARRAY', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'THEN', 'ELSE', 'CASE', 'WHEN', 'END')
      AND function_name NOT LIKE 'current_setting%'
    `);

    const functionNames = functionsQuery.rows.map(r => r.function_name);

    // Step 2: Analyze each function's definition
    const functionMappings = {};
    const userContextRequirements = {};
    const sessionVariables = new Set();

    for (const funcName of functionNames) {
      try {
        const funcDef = await client.query(`
          SELECT
            proname as name,
            prosrc as source,
            pg_get_functiondef(oid) as full_definition,
            prorettype::regtype as return_type
          FROM pg_proc
          WHERE proname = $1
          AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        `, [funcName]);

        if (funcDef.rows.length > 0) {
          const func = funcDef.rows[0];
          const analysis = analyzeFunctionBody(func.source, func.return_type);

          functionMappings[funcName] = analysis.mapping;

          // Track what this function requires
          if (analysis.requiresUserId) {
            userContextRequirements.id = true;
          }
          if (analysis.queriesTable) {
            userContextRequirements[analysis.returnField] = {
              table: analysis.queriesTable,
              lookupField: analysis.lookupField || 'user_id',
              description: `${funcName}() queries ${analysis.queriesTable} table`
            };
          }

          // Track session variables
          analysis.sessionVars.forEach(v => sessionVariables.add(v));
        }
      } catch (e) {
        console.warn(`Could not analyze function ${funcName}:`, e.message);
      }
    }

    // Step 3: Find all session variables used
    const settingsQuery = await client.query(`
      SELECT DISTINCT
        unnest(
          regexp_matches(
            pg_policies.qual || ' ' || COALESCE(pg_policies.with_check, ''),
            'current_setting\\s*\\(\\s*''([^'']+)''',
            'g'
          )
        ) as setting_name
      FROM pg_policies
      WHERE schemaname = 'public'
    `);

    settingsQuery.rows.forEach(r => sessionVariables.add(r.setting_name));

    await client.end();

    return {
      functionMappings,
      sessionVariables: Array.from(sessionVariables),
      userContextRequirements
    };

  } catch (error) {
    try {
      await client.end();
    } catch (e) {}

    console.warn('Could not analyze PostgreSQL functions:', error.message);
    return {
      functionMappings: {},
      sessionVariables: [],
      userContextRequirements: {}
    };
  }
}

/**
 * Analyze a PostgreSQL function body to understand what it does
 * @param {string} functionBody - The PL/pgSQL function source
 * @param {string} returnType - The return type of the function
 * @returns {Object} - Analysis results
 */
function analyzeFunctionBody(functionBody, returnType) {
  const analysis = {
    mapping: null,
    requiresUserId: false,
    queriesTable: null,
    returnField: null,
    lookupField: null,
    sessionVars: []
  };

  if (!functionBody) return analysis;

  // Detect session variable usage
  const sessionMatches = functionBody.matchAll(/current_setting\s*\(\s*'([^']+)'/gi);
  for (const match of sessionMatches) {
    analysis.sessionVars.push(match[1]);
    if (match[1].includes('user_id')) {
      analysis.requiresUserId = true;
    }
  }

  // Detect SELECT statements to understand what table is queried
  const selectMatch = functionBody.match(/SELECT\s+(\w+)(?:\.(\w+))?\s+INTO\s+\w+\s+FROM\s+(\w+)/i);
  if (selectMatch) {
    const fieldOrAlias = selectMatch[1];
    const fieldName = selectMatch[2] || fieldOrAlias;
    const tableName = selectMatch[3];

    analysis.queriesTable = tableName;

    // Infer the return field name
    if (fieldName === 'id' || fieldOrAlias === 'id') {
      analysis.returnField = `${tableName}_id`;
    } else {
      analysis.returnField = fieldName;
    }

    // Detect the lookup condition
    const whereMatch = functionBody.match(/WHERE\s+\w+\.(\w+)\s*=\s*current_setting/i);
    if (whereMatch) {
      analysis.lookupField = whereMatch[1];
    }

    // Generate JavaScript mapping
    if (returnType.includes('int')) {
      analysis.mapping = {
        type: 'lookup',
        returns: `user?.${analysis.returnField}`,
        description: `Looks up ${tableName}.id where ${tableName}.${analysis.lookupField} = current_user_id`
      };
    } else if (returnType.includes('char') || returnType.includes('text')) {
      // For string returns (like role), map directly
      const userTableMatch = functionBody.match(/FROM\s+["']?user["']?/i);
      if (userTableMatch) {
        // Querying user table directly
        analysis.mapping = {
          type: 'direct',
          returns: `user?.${analysis.returnField}`,
          description: `Returns user.${analysis.returnField}`
        };
      } else {
        analysis.mapping = {
          type: 'lookup',
          returns: `user?.${analysis.returnField}`,
          description: `Looks up ${tableName}.${analysis.returnField}`
        };
      }
    }
  }

  // If we couldn't parse it, make a best guess based on function patterns
  if (!analysis.mapping) {
    const funcName = functionBody.match(/FUNCTION\s+(\w+)/i)?.[1] || '';

    if (funcName.includes('role')) {
      analysis.mapping = {
        type: 'inferred',
        returns: 'user?.role',
        description: 'Inferred from function name'
      };
    } else if (funcName.includes('_id')) {
      const entity = funcName.replace(/get_current_|_id/gi, '');
      analysis.mapping = {
        type: 'inferred',
        returns: `user?.${entity}_id`,
        description: 'Inferred from function name'
      };
    } else {
      analysis.mapping = {
        type: 'unknown',
        returns: 'null',
        description: 'Could not analyze function'
      };
    }
  }

  return analysis;
}

/**
 * Generate a function mapping configuration
 * This can be saved to a file for manual adjustment if needed
 */
function generateMappingConfig(analysisResult) {
  const config = {
    // Metadata
    generated: new Date().toISOString(),
    source: 'PostgreSQL function analysis',

    // Function mappings
    functions: {},

    // Session variable mappings
    sessionVariables: {},

    // User context requirements
    userContext: {
      required: [],
      optional: [],
      relationships: {}
    }
  };

  // Build function mappings
  for (const [funcName, mapping] of Object.entries(analysisResult.functionMappings)) {
    config.functions[funcName] = {
      javascript: mapping.returns,
      description: mapping.description,
      type: mapping.type
    };
  }

  // Build session variable mappings
  for (const varName of analysisResult.sessionVariables) {
    if (varName.includes('user_id')) {
      config.sessionVariables[varName] = 'user.id';
    } else {
      // Infer from variable name
      const key = varName.split('.').pop().replace(/_/g, '');
      config.sessionVariables[varName] = `user.${key}`;
    }
  }

  // Build user context requirements
  for (const [field, requirement] of Object.entries(analysisResult.userContextRequirements)) {
    if (field === 'id') {
      config.userContext.required.push('id');
    } else {
      config.userContext.relationships[field] = requirement;
      config.userContext.optional.push(field);
    }
  }

  return config;
}

module.exports = {
  analyzeFunctions,
  analyzeFunctionBody,
  generateMappingConfig
};