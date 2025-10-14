const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { createConverter } = require('../parsers/autoRLSConverter');
const { createEnhancedConverter } = require('../parsers/enhancedRLSConverter');
const { analyzeFunctions, generateMappingConfig } = require('../parsers/functionAnalyzer');

/**
 * Auto-detect user table name (case-insensitive search for user/users)
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
 * Extract ACL policies from PostgreSQL RLS
 */
async function extractPostgreSQLPolicies(databaseUrl, models) {
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();

    const policies = {};

    // Create mapping from database table name to model name
    const tableToModelMap = {};
    for (const [modelName, modelData] of Object.entries(models)) {
      const dbName = modelData.dbName || modelName.toLowerCase();
      tableToModelMap[dbName] = modelName;
      policies[modelName] = [];
    }

    // Query all policies from PostgreSQL RLS (pg_policies)
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

    // Group policies by model (using table to model mapping)
    for (const row of result.rows) {
      const tableName = row.tablename;
      const modelName = tableToModelMap[tableName];

      if (modelName && policies[modelName] !== undefined) {
        policies[modelName].push({
          name: row.policyname,
          permissive: row.permissive === 'PERMISSIVE',
          roles: row.roles,
          command: row.cmd,
          using: row.qual,
          withCheck: row.with_check
        });
      }
    }

    await client.end();
    return policies;

  } catch (error) {
    try {
      await client.end();
    } catch (e) {}
    throw error;
  }
}

/**
 * Generate ACL functions for a single model from PostgreSQL policies
 */
function generateModelACL(modelName, policies, converter) {
  const hasPolicies = policies && policies.length > 0;

  if (!hasPolicies) {
    // No policies - generate permissive access
    return `    ${modelName}: {
        canCreate: (user) => true,
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

  // Generate each function
  const canCreateCode = generateFunction(insertPolicies, 'withCheck', converter, modelName);
  const accessFilterCode = generateFilter(selectPolicies, 'using', converter, modelName);
  let updateFilterCode = generateFilter(updatePolicies, 'using', converter, modelName);
  let deleteFilterCode = generateFilter(deletePolicies, 'using', converter, modelName);

  // If update/delete filters are empty/false but access filter is not, copy access filter
  if ((updateFilterCode === 'return false;' || updateFilterCode === 'return {};') &&
      accessFilterCode !== 'return false;' && accessFilterCode !== 'return {};') {
    updateFilterCode = accessFilterCode;
  }
  if ((deleteFilterCode === 'return false;' || deleteFilterCode === 'return {};') &&
      accessFilterCode !== 'return false;' && accessFilterCode !== 'return {};') {
    deleteFilterCode = accessFilterCode;
  }

  return `    ${modelName}: {
        canCreate: (user) => {
            ${canCreateCode}
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
 * Generate JavaScript function from policies
 */
function generateFunction(policies, expressionField, converter, modelName) {
  if (policies.length === 0) {
    return 'return true;';
  }

  const conditions = [];

  for (const policy of policies) {
    const expr = expressionField === 'withCheck'
      ? (policy.withCheck || policy.using)
      : policy[expressionField];

    if (expr) {
      try {
        const jsExpr = converter.convertToJavaScript(expr, 'data', 'user', modelName);
        console.log(`✓ Policy '${policy.name}': ${expr.substring(0, 50)}... -> ${jsExpr.substring(0, 80)}`);
        conditions.push(jsExpr);
      } catch (e) {
        console.warn(`⚠ Failed to convert policy '${policy.name}' for ${modelName}: ${e.message}`);
        console.warn(`  SQL: ${expr}`);
        conditions.push(`true /* TODO: Manual conversion needed for policy '${policy.name}' */`);
      }
    }
  }

  if (conditions.length === 0) {
    return 'return true;';
  }

  // If any condition is 'true', the entire expression is true
  if (conditions.some(c => c === 'true' || c.startsWith('true /*'))) {
    return 'return true;';
  }

  // Policies are OR'd together (any policy allows)
  return `return ${conditions.join(' || ')};`;
}

/**
 * Generate Prisma filter function
 */
function generateFilter(policies, expressionField, converter, modelName) {
  if (policies.length === 0) {
    return 'return false;';
  }

  const filtersWithRoles = [];

  for (const policy of policies) {
    const expr = policy[expressionField];
    if (expr) {
      try {
        const prismaFilter = converter.convertToPrismaFilter(expr, 'user', modelName);
        const analysis = converter.analyzer ? converter.analyzer.analyzeSQLForFilters(expr) : null;

        // Track role conditions and data filters separately
        const roleConditions = analysis?.conditions?.filter(c =>
          c.type === 'role_any' || c.type === 'role_equal'
        ) || [];

        filtersWithRoles.push({
          filter: prismaFilter,
          roleConditions,
          hasDataFilter: prismaFilter !== '{}'
        });
      } catch (e) {
        console.warn(`⚠ Failed to convert filter policy '${policy.name}' for ${modelName}: ${e.message}`);
        console.warn(`  SQL: ${expr}`);
        // On error, skip filter (fail-safe - no access)
      }
    }
  }

  if (filtersWithRoles.length === 0) {
    return 'return false;';
  }

  // Build conditional filter logic
  return buildConditionalFilter(filtersWithRoles);
}

/**
 * Build conditional filter with role checks
 */
function buildConditionalFilter(filtersWithRoles) {
  const roleOnlyFilters = [];
  const dataFilters = [];

  for (const item of filtersWithRoles) {
    if (item.roleConditions.length > 0 && !item.hasDataFilter) {
      // Pure role check - return {} if role matches
      roleOnlyFilters.push(...item.roleConditions);
    } else if (item.roleConditions.length > 0 && item.hasDataFilter) {
      // Has both role and data filter - already handled with if statement
      if (item.filter.includes('if (')) {
        return item.filter;
      }
      dataFilters.push(item.filter);
    } else if (item.hasDataFilter) {
      // Data filter only
      dataFilters.push(item.filter);
    }
  }

  // Generate conditional code
  const conditions = [];

  // Collect all roles that grant full access
  const rolesWithFullAccess = new Set();
  for (const roleCond of roleOnlyFilters) {
    if (roleCond.type === 'role_any') {
      roleCond.roles.forEach(r => rolesWithFullAccess.add(r));
    } else if (roleCond.type === 'role_equal') {
      rolesWithFullAccess.add(roleCond.role);
    }
  }

  // Add single consolidated role check if needed
  if (rolesWithFullAccess.size > 0) {
    const roleArray = Array.from(rolesWithFullAccess);
    if (roleArray.length === 1) {
      conditions.push(`if (user?.role === '${roleArray[0]}') { return {}; }`);
    } else {
      conditions.push(`if ([${roleArray.map(r => `'${r}'`).join(', ')}].includes(user?.role)) { return {}; }`);
    }
  }

  // Deduplicate data filters
  const uniqueDataFilters = [...new Set(dataFilters)];

  // Add final return with data filters
  if (uniqueDataFilters.length === 0) {
    conditions.push('return false;');
  } else if (uniqueDataFilters.length === 1) {
    conditions.push(`return ${uniqueDataFilters[0]};`);
  } else {
    conditions.push(`return { OR: [${uniqueDataFilters.join(', ')}] };`);
  }

  return conditions.join(' ');
}

/**
 * Generate complete acl.js file
 */
async function generateACL(models, outputPath, databaseUrl, isPostgreSQL, userTableOption, relationships = {}, debug = false, allModels = null) {
  // Use allModels for user table detection if provided (when filtering by model)
  const modelsForUserDetection = allModels || models;
  const userTable = detectUserTable(modelsForUserDetection, userTableOption);
  const modelNames = Object.keys(models);

  let policies = {};
  const timestamp = new Date().toISOString();

  let aclCode = `const acl = {\n    model: {},\n    lastUpdateDate: '${timestamp}'\n};\n\n`;

  // Create enhanced converter with analyzed functions, models, and relationships
  let converter = createEnhancedConverter({}, {}, models, relationships);

  if (isPostgreSQL && databaseUrl) {
    console.log('PostgreSQL detected - analyzing database...');

    // Step 1: Analyze functions
    try {
      const functionAnalysis = await analyzeFunctions(databaseUrl);
      console.log(`✓ Analyzed ${Object.keys(functionAnalysis.functionMappings).length} PostgreSQL functions`);

      // Create enhanced converter with analyzed mappings, models, and relationships
      converter = createEnhancedConverter(
        functionAnalysis.functionMappings,
        functionAnalysis.sessionVariables,
        models,
        relationships
      );

      // Save function analysis for debugging (only if --debug flag is set)
      if (debug) {
        const configPath = path.join(path.dirname(outputPath), 'acl-mappings.json');
        const mappingConfig = generateMappingConfig(functionAnalysis);
        fs.writeFileSync(configPath, JSON.stringify(mappingConfig, null, 2));
        console.log(`✓ Function mappings saved to ${configPath}`);
      }

      // Also add user context requirements as a comment in acl.js
      if (Object.keys(functionAnalysis.userContextRequirements).length > 0) {
        aclCode = `/**
 * User Context Requirements:
 * The user object should contain:
${Object.entries(functionAnalysis.userContextRequirements)
  .map(([field, req]) => ` * - ${field}: ${typeof req === 'object' ? req.description : 'required'}`)
  .join('\n')}
 */

` + aclCode;
      }
    } catch (error) {
      console.warn(`⚠ Could not analyze functions: ${error.message}`);
    }

    // Step 2: Extract policies
    try {
      policies = await extractPostgreSQLPolicies(databaseUrl, models);
      const totalPolicies = Object.values(policies).reduce((sum, p) => sum + p.length, 0);
      console.log(`✓ Extracted ${totalPolicies} policies from PostgreSQL RLS`);
    } catch (error) {
      console.warn(`⚠ Failed to extract PostgreSQL policies: ${error.message}`);
      console.log('Generating permissive ACL for all models...');
      for (const modelName of modelNames) {
        policies[modelName] = [];
      }
    }
  } else {
    if (!isPostgreSQL) {
      console.log('Non-PostgreSQL database detected - generating permissive ACL');
    }
    console.log('Generating permissive ACL for all models...');
    for (const modelName of modelNames) {
      policies[modelName] = [];
    }
  }

  // Generate ACL for each model
  aclCode += 'acl.model = {\n';
  const modelACLCode = modelNames.map(modelName => {
    return generateModelACL(modelName, policies[modelName], converter);
  });
  aclCode += modelACLCode.join(',\n');
  aclCode += '\n};\n\n';
  aclCode += 'module.exports = acl;\n';

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, aclCode);
  console.log('✓ Generated acl.js with dynamic function mappings');
}

module.exports = {
  generateACL
};