const fs = require('fs');
const path = require('path');
const { parsePrismaSchema, parsePrismaDMMF } = require('../parsers/prismaParser');
const { generateAllModels } = require('../generators/modelGenerator');
const { generateRelationshipsFromDMMF, generateRelationshipsFromSchema } = require('../generators/relationshipsGenerator');
const { generateACL } = require('../generators/aclGenerator');
const { parseDatasource } = require('../parsers/datasourceParser');
const { generateAllRoutes } = require('../generators/routeGenerator');

/**
 * Generate rapidd/rapidd.js file
 * @param {string} rapiddJsPath - Path to rapidd.js
 * @param {boolean} isPostgreSQL - Whether the database is PostgreSQL
 */
function generateRapiddFile(rapiddJsPath, isPostgreSQL = true) {
  let content;

  if (isPostgreSQL) {
    // PostgreSQL version with RLS support
    content = `const { PrismaClient, Prisma } = require('../prisma/client');
const { AsyncLocalStorage } = require('async_hooks');
const acl = require('./acl');

// Request Context Storage
const requestContext = new AsyncLocalStorage();

// RLS Configuration aus Environment Variables
const RLS_CONFIG = {
    namespace: process.env.RLS_NAMESPACE || 'app',
    userId: process.env.RLS_USER_ID || 'current_user_id',
    userRole: process.env.RLS_USER_ROLE || 'current_user_role',
};

// =====================================================
// BASE PRISMA CLIENTS
// =====================================================

/**
 * ADMIN CLIENT - Bypasses ALL RLS
 * Uses DATABASE_URL_ADMIN connection (e.g., app_auth_proxy user)
 * Use ONLY for authentication operations:
 * - Login
 * - Register
 * - Email Verification
 * - Password Reset
 * - OAuth operations
 */
const authPrisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL_ADMIN
        }
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

/**
 * BASE CLIENT - Regular user with RLS
 * Uses DATABASE_URL connection
 * Use for all business operations
 */
const basePrisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL
        }
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// =====================================================
// RLS HELPER FUNCTIONS
// =====================================================

/**
 * Set RLS Session Variables in PostgreSQL
 * Execute each SET command separately to avoid prepared statement error
 */
async function setRLSVariables(tx, userId, userRole) {
    const namespace = RLS_CONFIG.namespace;
    const userIdVar = RLS_CONFIG.userId;
    const userRoleVar = RLS_CONFIG.userRole;

    // Execute SET commands separately
    await tx.$executeRawUnsafe(\`SET LOCAL \${namespace}.\${userIdVar} = '\${userId}'\`);
    await tx.$executeRawUnsafe(\`SET LOCAL \${namespace}.\${userRoleVar} = '\${userRole}'\`);
}

/**
 * Reset RLS Session Variables
 */
async function resetRLSVariables(tx) {
    const namespace = RLS_CONFIG.namespace;
    const userIdVar = RLS_CONFIG.userId;
    const userRoleVar = RLS_CONFIG.userRole;

    try {
        await tx.$executeRawUnsafe(\`RESET \${namespace}.\${userIdVar}\`);
        await tx.$executeRawUnsafe(\`RESET \${namespace}.\${userRoleVar}\`);
    } catch (e) {
        // Ignore errors on reset
        console.error('Failed to reset RLS variables:', e);
    }
}

// =====================================================
// EXTENDED PRISMA WITH AUTOMATIC RLS
// =====================================================

/**
 * Extended Prisma Client with automatic RLS context
 * Automatically wraps all operations in RLS context from AsyncLocalStorage
 */
const prisma = basePrisma.$extends({
    query: {
        async $allOperations({ operation, args, query, model }) {
            const context = requestContext.getStore();

            // No context = no RLS (e.g., system operations)
            if (!context?.userId || !context?.userRole) {
                return query(args);
            }

            const { userId, userRole } = context;

            // For operations that are already transactions, just set the variables
            if (operation === '$transaction') {
                return basePrisma.$transaction(async (tx) => {
                    await setRLSVariables(tx, userId, userRole);
                    return query(args);
                });
            }

            // For regular operations, wrap in transaction with RLS
            return basePrisma.$transaction(async (tx) => {
                // Set session variables
                await setRLSVariables(tx, userId, userRole);

                // Execute the original query using the transaction client
                if (model) {
                    // Model query (e.g., user.findMany())
                    return tx[model][operation](args);
                } else {
                    // Raw query or special operation
                    return tx[operation](args);
                }
            });
        },
    },
});

// =====================================================
// TRANSACTION HELPERS
// =====================================================

/**
 * Helper for batch operations in single transaction
 */
async function prismaTransaction(operations) {
    const context = requestContext.getStore();

    return basePrisma.$transaction(async (tx) => {
        if (context?.userId && context?.userRole) {
            await setRLSVariables(tx, context.userId, context.userRole);
        }
        return Promise.all(operations.map(op => op(tx)));
    });
}

// =====================================================
// CONTEXT HELPERS
// =====================================================

/**
 * Express Middleware: Set RLS context from authenticated user
 * Use this AFTER your authentication middleware
 */
function setRLSContext(req, res, next) {
    if (req.user) {
        // Set context for async operations
        requestContext.run(
            {
                userId: req.user.id,
                userRole: req.user.role
            },
            () => next()
        );
    } else {
        next();
    }
}

/**
 * Get RLS Config (for SQL generation)
 */
function getRLSConfig() {
    return RLS_CONFIG;
}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function disconnectAll() {
    await authPrisma.$disconnect();
    await basePrisma.$disconnect();
}

process.on('beforeExit', async () => {
    await disconnectAll();
});

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
    // Main clients
    prisma,              // Use for regular operations with automatic RLS from context
    authPrisma,          // Use ONLY for auth operations (login, register, etc.)

    // Transaction helpers
    prismaTransaction,

    // Context helpers
    requestContext,
    setRLSContext,

    // RLS utilities
    setRLSVariables,
    resetRLSVariables,
    getRLSConfig,

    // Utilities
    disconnectAll,
    PrismaClient,
    Prisma,
    acl
};
`;
  } else {
    // Non-PostgreSQL version (MySQL, SQLite, etc.) - simplified without RLS
    content = `const { PrismaClient } = require('../prisma/client');
const acl = require('./acl');

// Standard Prisma Client
const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

const prismaTransaction = async (operations) => prisma.$transaction(async (tx) => {
    return Promise.all(operations.map(op => op(tx)));
});

module.exports = {
    prisma,
    prismaTransaction,
    PrismaClient,
    acl
};
`;
  }

  // Ensure rapidd directory exists
  const rapiddDir = path.dirname(rapiddJsPath);
  if (!fs.existsSync(rapiddDir)) {
    fs.mkdirSync(rapiddDir, { recursive: true });
  }

  fs.writeFileSync(rapiddJsPath, content);
  console.log('✓ Generated rapidd/rapidd.js');
}

/**
 * Update relationships.json for a specific model
 */
async function updateRelationshipsForModel(filteredModels, relationshipsPath, schemaPath, usedDMMF) {
  let existingRelationships = {};

  // Load existing relationships if file exists
  if (fs.existsSync(relationshipsPath)) {
    try {
      existingRelationships = JSON.parse(fs.readFileSync(relationshipsPath, 'utf8'));
    } catch (error) {
      console.warn('Could not parse existing relationships.json, will create new');
    }
  }

  // Generate relationships for the filtered model(s)
  let newRelationships = {};
  if (usedDMMF) {
    // Use DMMF to get relationships for specific model
    const { generateRelationshipsFromDMMF } = require('../generators/relationshipsGenerator');
    const tempPath = relationshipsPath + '.tmp';
    await generateRelationshipsFromDMMF(schemaPath, tempPath);
    const allRelationships = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
    fs.unlinkSync(tempPath);

    // Extract only the filtered model's relationships
    for (const modelName of Object.keys(filteredModels)) {
      if (allRelationships[modelName]) {
        newRelationships[modelName] = allRelationships[modelName];
      }
    }
  } else {
    // Use schema parser
    const { generateRelationshipsFromSchema } = require('../generators/relationshipsGenerator');
    const tempPath = relationshipsPath + '.tmp';
    generateRelationshipsFromSchema(schemaPath, tempPath);
    const allRelationships = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
    fs.unlinkSync(tempPath);

    // Extract only the filtered model's relationships
    for (const modelName of Object.keys(filteredModels)) {
      if (allRelationships[modelName]) {
        newRelationships[modelName] = allRelationships[modelName];
      }
    }
  }

  // Merge with existing relationships
  const updatedRelationships = { ...existingRelationships, ...newRelationships };

  // Write back to file
  fs.writeFileSync(relationshipsPath, JSON.stringify(updatedRelationships, null, 2));
}

/**
 * Update acl.js for a specific model
 */
async function updateACLForModel(filteredModels, allModels, aclPath, datasource, userTable, relationships, debug = false) {
  const { generateACL } = require('../generators/aclGenerator');

  // Generate ACL for the filtered model (but pass all models for user table detection)
  const tempPath = aclPath + '.tmp';
  await generateACL(
    filteredModels,
    tempPath,
    datasource.url,
    datasource.isPostgreSQL,
    userTable,
    relationships,
    debug,
    allModels
  );

  // Read the generated ACL for the specific model
  const tempContent = fs.readFileSync(tempPath, 'utf8');
  fs.unlinkSync(tempPath);

  // Extract the model's ACL configuration
  const modelName = Object.keys(filteredModels)[0];

  // Find the start of the model definition
  const modelStart = tempContent.indexOf(`${modelName}:`);
  if (modelStart === -1) {
    throw new Error(`Could not find model ${modelName} in generated RLS`);
  }

  // Find the matching closing brace by counting braces
  let braceCount = 0;
  let inString = false;
  let stringChar = null;
  let i = tempContent.indexOf('{', modelStart);
  const contentStart = i;

  for (; i < tempContent.length; i++) {
    const char = tempContent[i];
    const prevChar = i > 0 ? tempContent[i - 1] : '';

    // Handle string literals
    if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
        stringChar = null;
      }
    }

    if (!inString) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;

      if (braceCount === 0) {
        // Found the closing brace
        break;
      }
    }
  }

  if (braceCount !== 0) {
    throw new Error(`Could not extract ACL for model ${modelName} - unmatched braces`);
  }

  const modelAcl = tempContent.substring(modelStart, i + 1);

  // Read existing acl.js
  if (fs.existsSync(aclPath)) {
    let existingContent = fs.readFileSync(aclPath, 'utf8');

    // Check if model already exists in ACL
    const existingModelPattern = new RegExp(`${modelName}:\\s*\\{[\\s\\S]*?\\n    \\}(?=,|\\n)`);

    if (existingModelPattern.test(existingContent)) {
      // Replace existing model ACL
      existingContent = existingContent.replace(existingModelPattern, modelAcl);
    } else {
      // Add new model ACL before the closing of acl.model
      // Find the last closing brace of a model object and add comma after it
      existingContent = existingContent.replace(
        /(\n    \})\n(\};)/,
        `$1,\n    ${modelAcl}\n$2`
      );
    }

    fs.writeFileSync(aclPath, existingContent);
    console.log(`✓ Updated RLS for model: ${modelName}`);
  } else {
    // If acl.js doesn't exist, create it with just this model
    await generateACL(
      filteredModels,
      aclPath,
      datasource.url,
      datasource.isPostgreSQL,
      userTable,
      relationships,
      debug,
      allModels
    );
  }
}

/**
 * Build models from Prisma schema
 * @param {Object} options - Build options
 * @param {string} options.schema - Path to Prisma schema file
 * @param {string} options.output - Output directory for generated models
 * @param {string} options.model - Optional: specific model to generate
 * @param {string} options.only - Optional: specific component to generate
 */
async function buildModels(options) {
  const schemaPath = path.resolve(process.cwd(), options.schema);
  const outputBase = path.resolve(process.cwd(), options.output);

  // If output is "/", use process.cwd() as the base
  const baseDir = options.output === '/' ? process.cwd() : outputBase;

  // Construct paths
  const srcDir = path.join(baseDir, 'src');
  const modelDir = path.join(srcDir, 'Model');
  const modelJsPath = path.join(srcDir, 'Model.js');
  const rapiddDir = path.join(baseDir, 'rapidd');
  const relationshipsPath = path.join(rapiddDir, 'relationships.json');
  const aclPath = path.join(rapiddDir, 'acl.js');
  const rapiddJsPath = path.join(rapiddDir, 'rapidd.js');
  const routesDir = path.join(baseDir, 'routes', 'api', 'v1');
  const logsDir = path.join(baseDir, 'logs');

  console.log('Building Rapidd models...');
  console.log(`Schema: ${schemaPath}`);
  console.log(`Output: ${baseDir}`);

  // Create logs directory
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Check if schema file exists
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Prisma schema file not found at: ${schemaPath}`);
  }

  // Run npx prisma generate first
  console.log('\nRunning npx prisma generate...');
  const { execSync } = require('child_process');
  try {
    execSync(`npx prisma generate --schema=${schemaPath}`, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    console.log('✓ Prisma client generated successfully\n');
  } catch (error) {
    console.warn('⚠ Warning: Failed to generate Prisma client');
    console.warn('Continuing with schema parsing fallback...\n');
  }

  // Try to use Prisma DMMF first (using @prisma/internals getDMMF)
  let parsedData = null;
  let usedDMMF = false;

  try {
    parsedData = await parsePrismaDMMF(schemaPath);
    if (parsedData) {
      console.log('Using Prisma DMMF (via @prisma/internals)');
      usedDMMF = true;
    }
  } catch (error) {
    // Fall back to schema parsing
  }

  // If DMMF parsing failed, parse schema file directly
  if (!parsedData) {
    console.log('Parsing Prisma schema file...');
    parsedData = parsePrismaSchema(schemaPath);
  }

  const { models, enums } = parsedData;

  // Filter models if --model option is provided
  let filteredModels = models;
  if (options.model) {
    const modelName = options.model.toLowerCase();
    const matchedModel = Object.keys(models).find(m => m.toLowerCase() === modelName);

    if (!matchedModel) {
      throw new Error(`Model "${options.model}" not found in schema. Available models: ${Object.keys(models).join(', ')}`);
    }

    filteredModels = { [matchedModel]: models[matchedModel] };
    console.log(`Filtering to model: ${matchedModel}`);
  }

  console.log(`Found ${Object.keys(models).length} models${options.model ? ` (generating ${Object.keys(filteredModels).length})` : ''}`);

  // Determine which components to generate
  const shouldGenerate = {
    model: !options.only || options.only === 'model',
    route: !options.only || options.only === 'route',
    acl: !options.only || options.only === 'acl',
    relationship: !options.only || options.only === 'relationship'
  };

  // Validate --only option
  if (options.only && !['model', 'route', 'acl', 'relationship'].includes(options.only)) {
    throw new Error(`Invalid --only value "${options.only}". Must be one of: model, route, acl, relationship`);
  }

  // Generate model files
  if (shouldGenerate.model) {
    generateAllModels(filteredModels, modelDir, modelJsPath);
  }

  // Parse datasource to determine database type
  let datasource = { isPostgreSQL: true, url: null };  // Default to PostgreSQL
  try {
    datasource = parseDatasource(schemaPath);
  } catch (error) {
    // Only warn if it's not the expected "No url found" error in Prisma 7
    if (!error.message.includes('No url found')) {
      console.warn('Could not parse datasource, assuming PostgreSQL:', error.message);
    }
  }

  // Generate rapidd/rapidd.js if it doesn't exist
  if (!fs.existsSync(rapiddJsPath)) {
    console.log('Generating rapidd/rapidd.js...');
    generateRapiddFile(rapiddJsPath, datasource.isPostgreSQL);
  }

  // Generate relationships.json
  if (shouldGenerate.relationship) {
    console.log(`\nGenerating relationships.json...`);

    try {
      if (options.model) {
        // Update only specific model in relationships.json
        await updateRelationshipsForModel(filteredModels, relationshipsPath, schemaPath, usedDMMF);
      } else {
        // Generate all relationships
        if (usedDMMF) {
          await generateRelationshipsFromDMMF(schemaPath, relationshipsPath);
        } else {
          generateRelationshipsFromSchema(schemaPath, relationshipsPath);
        }
      }
      console.log(`✓ Relationships file generated at: ${relationshipsPath}`);
    } catch (error) {
      console.error('Failed to generate relationships.json:', error.message);
      console.log('Note: You may need to create relationships.json manually.');
    }
  }

  // Generate ACL configuration
  if (shouldGenerate.acl) {
    console.log(`\nGenerating ACL configuration...`);

    // Load relationships for Prisma filter building
    let relationships = {};
    try {
      if (fs.existsSync(relationshipsPath)) {
        relationships = JSON.parse(fs.readFileSync(relationshipsPath, 'utf8'));
      }
    } catch (error) {
      console.warn('Could not load relationships.json:', error.message);
    }

    try {

      // For non-PostgreSQL databases (MySQL, SQLite, etc.), generate permissive ACL
      if (!datasource.isPostgreSQL) {
        console.log(`${datasource.provider || 'Non-PostgreSQL'} database detected - generating permissive ACL...`);
        await generateACL(models, aclPath, null, false, options.userTable, relationships, options.debug);
      } else if (options.model) {
        // Update only specific model in acl.js
        await updateACLForModel(filteredModels, models, aclPath, datasource, options.userTable, relationships, options.debug);
      } else {
        // Generate ACL for all models
        await generateACL(
          models,
          aclPath,
          datasource.url,
          datasource.isPostgreSQL,
          options.userTable,
          relationships,
          options.debug
        );
      }
    } catch (error) {
      console.error('Failed to generate ACL:', error.message);
      console.log('Generating permissive ACL fallback...');
      // Pass null for URL and false for isPostgreSQL to skip database connection
      await generateACL(models, aclPath, null, false, options.userTable, relationships, options.debug);
    }
  }

  // Generate routes
  if (shouldGenerate.route) {
    generateAllRoutes(filteredModels, routesDir);
  }

  return { models, enums };
}

module.exports = {
  buildModels
};
