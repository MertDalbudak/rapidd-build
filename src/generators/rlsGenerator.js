const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { createConverter } = require('../parsers/autoRLSConverter');
const { analyzeFunctions, generateMappingConfig } = require('../parsers/functionAnalyzer');

/**
 * Auto-detect user table name (case-insensitive search for user/users)
 * @param {Object} models - Models object from parser
 * @param {string} userTableOption - User-specified table name (optional)
 * @returns {string} - Name of the user table
 */
function detectUserTable(models, userTableOption) {
  if (userTableOption) {
    return userTableOption;
  }

  const modelNames = Object.keys(models);
  const userTables = modelNames.filter(name =>
    name.toLowerCase() === 'user' || name.toLowerCase() === 'users'
  );

  if (userTables.length === 0) {
    throw new Error('No user table found (user/users). Please specify --user-table option.');
  }

  if (userTables.length > 1) {
    throw new Error(`Multiple user tables found: ${userTables.join(', ')}. Please specify --user-table option.`);
  }

  return userTables[0];
}

/**
 * Extract RLS policies from PostgreSQL
 * @param {string} databaseUrl - PostgreSQL connection URL
 * @param {Array} modelNames - Array of model names
 * @returns {Object} - RLS policies for each table
 */
async function extractPostgreSQLPolicies(databaseUrl, modelNames) {
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();

    const policies = {};

    // Initialize all models with empty policies
    for (const modelName of modelNames) {
      policies[modelName] = [];
    }

    // Query all RLS policies from pg_policies
    const result = await client.query(`
      SELECT
        tablename,
        policyname,
        permissive,
        roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `);

    // Group policies by table
    for (const row of result.rows) {
      const tableName = row.tablename;
      if (policies[tableName] !== undefined) {
        policies[tableName].push({
          name: row.policyname,
          permissive: row.permissive === 'PERMISSIVE',
          roles: row.roles,
          command: row.cmd, // SELECT, INSERT, UPDATE, DELETE, ALL
          using: row.qual, // USING expression
          withCheck: row.with_check // WITH CHECK expression
        });
      }
    }

    await client.end();
    return policies;

  } catch (error) {
    try {
      await client.end();
    } catch (e) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Generate RLS functions for a single model from PostgreSQL policies
 * @param {string} modelName - Name of the model
 * @param {Array} policies - Array of policy objects for this model
 * @param {string} userTable - Name of the user table
 * @returns {string} - JavaScript code for RLS functions
 */
function generateModelRLS(modelName, policies, userTable) {
  const hasPolicies = policies && policies.length > 0;

  if (!hasPolicies) {
    // No RLS policies - generate permissive access
    return `    ${modelName}: {
        canCreate: (user) => true,
        hasAccess: (data, user) => true,
        getAccessFilter: (user) => ({}),
        getUpdateFilter: (user) => ({}),
        getDeleteFilter: (user) => ({}),
        getOmitFields: (user) => []
    }`;
  }

  // Find policies by command type
  const selectPolicies = policies.filter(p => p.command === 'SELECT' || p.command === 'ALL');
  const insertPolicies = policies.filter(p => p.command === 'INSERT' || p.command === 'ALL');
  const updatePolicies = policies.filter(p => p.command === 'UPDATE' || p.command === 'ALL');
  const deletePolicies = policies.filter(p => p.command === 'DELETE' || p.command === 'ALL');

  // Generate canCreate (INSERT policies with WITH CHECK)
  const canCreateCode = generateCanCreate(insertPolicies);

  // Generate hasAccess (SELECT policies with USING)
  const hasAccessCode = generateHasAccess(selectPolicies);

  // Generate getAccessFilter (SELECT policies)
  const accessFilterCode = generateFilter(selectPolicies, 'using');

  // Generate getUpdateFilter (UPDATE policies)
  const updateFilterCode = generateFilter(updatePolicies, 'using');

  // Generate getDeleteFilter (DELETE policies)
  const deleteFilterCode = generateFilter(deletePolicies, 'using');

  return `    ${modelName}: {
        canCreate: (user) => {
            ${canCreateCode}
        },
        hasAccess: (data, user) => {
            ${hasAccessCode}
        },
        getAccessFilter: (user) => {
            ${accessFilterCode}
        },
        getUpdateFilter: (user) => {
            ${updateFilterCode}
        },
        getDeleteFilter: (user) => {
            ${deleteFilterCode}
        },
        getOmitFields: (user) => []
    }`;
}

/**
 * Generate canCreate function from INSERT policies
 */
function generateCanCreate(insertPolicies, converter) {
  if (insertPolicies.length === 0) {
    return 'return true;';
  }

  const conditions = [];

  for (const policy of insertPolicies) {
    const expr = policy.withCheck || policy.using;
    if (expr) {
      try {
        const jsExpr = converter.convertToJavaScript(expr, 'data', 'user');
        conditions.push(jsExpr);
      } catch (e) {
        conditions.push(`true /* Error parsing: ${expr.substring(0, 50)}... */`);
      }
    }
  }

  if (conditions.length === 0) {
    return 'return true;';
  }

  // Policies are OR'd together (any policy allows)
  return `return ${conditions.join(' || ')};`;
}

/**
 * Generate hasAccess function from SELECT policies
 */
function generateHasAccess(selectPolicies) {
  if (selectPolicies.length === 0) {
    return 'return true;';
  }

  const conditions = [];

  for (const policy of selectPolicies) {
    if (policy.using) {
      try {
        const jsExpr = convertToJavaScript(policy.using, 'data', 'user');
        conditions.push(jsExpr);
      } catch (e) {
        conditions.push(`true /* Error parsing: ${policy.using.substring(0, 50)}... */`);
      }
    }
  }

  if (conditions.length === 0) {
    return 'return true;';
  }

  // Policies are OR'd together (any policy allows)
  return `return ${conditions.join(' || ')};`;
}

/**
 * Generate Prisma filter function
 */
function generateFilter(policies, expressionField) {
  if (policies.length === 0) {
    return 'return {};';
  }

  const filters = [];

  for (const policy of policies) {
    const expr = policy[expressionField];
    if (expr) {
      try {
        const prismaFilter = convertToPrismaFilter(expr, 'user');
        if (prismaFilter !== '{}') {
          filters.push(prismaFilter);
        }
      } catch (e) {
        // On error, return empty filter (permissive)
      }
    }
  }

  if (filters.length === 0) {
    return 'return {};';
  }

  if (filters.length === 1) {
    return `return ${filters[0]};`;
  }

  // Multiple policies are OR'd together
  return `return { OR: [${filters.join(', ')}] };`;
}

/**
 * Generate complete rls.js file
 * @param {Object} models - Models object
 * @param {string} outputPath - Path to output rls.js
 * @param {string} databaseUrl - Database connection URL
 * @param {boolean} isPostgreSQL - Whether database is PostgreSQL
 * @param {string} userTableOption - User-specified table name
 */
async function generateRLS(models, outputPath, databaseUrl, isPostgreSQL, userTableOption) {
  const userTable = detectUserTable(models, userTableOption);
  const modelNames = Object.keys(models);

  let policies = {};
  const timestamp = new Date().toISOString();

  let rlsCode = `const rls = {\n    model: {},\n    lastUpdateDate: '${timestamp}'\n};\n\n`;

  // Analyze PostgreSQL functions if available
  let functionAnalysis = null;

  if (isPostgreSQL && databaseUrl) {
    console.log('PostgreSQL detected - analyzing database functions...');
    try {
      functionAnalysis = await analyzeFunctions(databaseUrl);
      console.log(`✓ Analyzed ${Object.keys(functionAnalysis.functionMappings).length} PostgreSQL functions`);

      // Save function analysis for debugging/manual adjustment
      const configPath = path.join(path.dirname(outputPath), 'rls-mappings.json');
      const mappingConfig = generateMappingConfig(functionAnalysis);
      fs.writeFileSync(configPath, JSON.stringify(mappingConfig, null, 2));
      console.log(`✓ Function mappings saved to ${configPath}`);
    } catch (error) {
      console.warn(`⚠ Could not analyze functions: ${error.message}`);
    }

    console.log('Extracting RLS policies from database...');
    try {
      policies = await extractPostgreSQLPolicies(databaseUrl, modelNames);
      const totalPolicies = Object.values(policies).reduce((sum, p) => sum + p.length, 0);
      console.log(`✓ Extracted ${totalPolicies} RLS policies from PostgreSQL`);
    } catch (error) {
      console.warn(`⚠ Failed to extract PostgreSQL RLS: ${error.message}`);
      console.log('Generating permissive RLS for all models...');
      // Initialize empty policies for all models
      for (const modelName of modelNames) {
        policies[modelName] = [];
      }
    }
  } else {
    if (!isPostgreSQL) {
      console.log('Non-PostgreSQL database detected (MySQL/SQLite/etc) - RLS not supported');
    }
    console.log('Generating permissive RLS for all models...');
    // Initialize empty policies for all models
    for (const modelName of modelNames) {
      policies[modelName] = [];
    }
  }

  // Generate RLS for each model
  rlsCode += 'rls.model = {\n';
  const modelRLSCode = modelNames.map(modelName => {
    return generateModelRLS(modelName, policies[modelName], userTable);
  });
  rlsCode += modelRLSCode.join(',\n');
  rlsCode += '\n};\n\n';
  rlsCode += 'module.exports = rls;\n';

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, rlsCode);
  console.log('Generated rls.js');
}

module.exports = {
  generateRLS
};
