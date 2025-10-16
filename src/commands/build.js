const fs = require('fs');
const path = require('path');
const { parsePrismaSchema, parsePrismaDMMF } = require('../parsers/prismaParser');
const { generateAllModels } = require('../generators/modelGenerator');
const { generateRelationshipsFromDMMF, generateRelationshipsFromSchema } = require('../generators/relationshipsGenerator');
const { generateACL } = require('../generators/aclGenerator');
const { parseDatasource } = require('../parsers/datasourceParser');
const { generateAllRoutes } = require('../generators/routeGenerator');

/**
 * Generate src/Model.js base class file
 */
function generateBaseModelFile(modelJsPath) {
  const content = `const { QueryBuilder, prisma, prismaTransaction } = require("./QueryBuilder");
const {acl} = require('../rapidd/rapidd');
const {ErrorResponse} = require('./Api');

class Model {
    /**
         * @param {string} name
         * @param {{'user': {}}} options
         */
    constructor(name, options){
        this.modelName = name;
        this.queryBuilder = new QueryBuilder(name);
        this.acl = acl.model[name] || {};
        this.options = options || {}
        this.user = this.options.user || {'id': 1, 'role': 'application'};
        this.user_id = this.user ? this.user.id : null;
    }

    _select = (fields) => this.queryBuilder.select(fields);
    _filter = (q) => this.queryBuilder.filter(q);
    _include = (include) => this.queryBuilder.include(include, this.user);
    // ACL METHODS
    _canCreate = () => this.acl.canCreate(this.user);
    _getAccessFilter = () => this.acl.getAccessFilter?.(this.user);
    _getUpdateFilter = () => this.acl.getUpdateFilter(this.user);
    _getDeleteFilter = () => this.acl.getDeleteFilter(this.user);
    _omit = () => this.queryBuilder.omit(this.user);

    /**
     *
     * @param {string} q
     * @property {string|Object} include
     * @param {number} limit
     * @param {number} offset
     * @param {string} sortBy
     * @param {'asc'|'desc'} sortOrder
     * @returns {Promise<Object[]>}
     */
    _getMany = async (q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc", options = {})=>{
        const take = this.take(Number(limit));
        const skip = this.skip(Number(offset));

        sortBy = sortBy.trim();
        sortOrder = sortOrder.trim();
        if (!sortBy.includes('.') && this.fields[sortBy] == undefined) {
            throw new ErrorResponse(400, "invalid_sort_field", {sortBy, modelName: this.constructor.name});
        }

        // Query the database using Prisma with filters, pagination, and limits
        const [data, total] = await prismaTransaction([
            (tx) => tx[this.name].findMany({
                'where': this.filter(q),
                'include': this.include(include),
                'take': take,
                'skip': skip,
                'orderBy': this.sort(sortBy, sortOrder),
                'omit': this._omit(),
                ...options
            }),
            (tx) => tx[this.name].count({
                'where': this.filter(q)
            })
        ]);
        return {data, meta: {take, skip, total}};
    }
    /**
     * @param {number} id
     * @param {string | Object} include
     * @returns {Promise<{} | null>}
     */
    _get = async (id, include, options = {}) =>{
        const {omit, ..._options} = options;
        id = Number(id);
        // To determine if the record is inaccessible, either due to non-existence or insufficient permissions, two simultaneous queries are performed.
        const _response = this.prisma.findUnique({
            'where': {
                'id': id
            },
            'include': this.include(include),
            'omit': {...this._omit(), ...omit},
            ..._options
        });

        const _checkPermission = this.prisma.findUnique({
            'where': {
                'id': id,
                ...this.getAccessFilter()
            },
            'select': {
                'id': true
            }
        });

        const [response, checkPermission] = await Promise.all([_response, _checkPermission]);
        if(response){
            if(checkPermission){
                if(response.id != checkExistence?.id){   // IN CASE access_filter CONTAINS id FIELD
                    throw new ErrorResponse(getTranslation("no_permission"), 403);
                }
            }
            else{
                throw new ErrorResponse(getTranslation("no_permission"), 403);
            }
        }
        else{
            throw new ErrorResponse(getTranslation("record_not_found"), 404);
        }
        return response;
    }
    /**
     * @param {{}} data
     * @returns {Promise<Object>}
     */
    _create = async (data, options = {}) => {
        // CHECK CREATE PERMISSION
        if (!this.canCreate()) {
            throw new ErrorResponse(403, "no_permission_to_create");
        }

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.queryBuilder.create(data, this.user_id);

        // CREATE
        return await this.prisma.create({
            'data': data,
            'include': this.include('ALL'),
            ...options
        });
    }

    /**
     * @param {number} id
     * @param {{}} data
     * @returns {Promise<Object>}
     */
    _update = async (id, data, options = {}) => {
        id = Number(id);

        // CHECK UPDATE PERMISSION
        const updateFilter = this.getUpdateFilter();
        if (updateFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_update");
        }

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.queryBuilder.update(id, data, this.user_id);
        const response = await this.prisma.update({
            'where': {
                'id': id,
                ...updateFilter
            },
            'data': data,
            'include': this.include('ALL'),
            ...options
        });
        if(response){
            return response;
        }
        throw new ErrorResponse(403, "no_permission");
    }

    /**
     *
     * @param {string} q
     * @returns {Promise<number>}
     */
    _count = async (q = {}) => {
        return await this.prisma.count({
            'where': this.filter(q)
        });
    }

    /**
     * @param {number} id
     * @returns {Promise<Object>}
     */
    _delete = async (id, options = {}) => {
        id = Number(id);

        // CHECK DELETE PERMISSION
        const deleteFilter = this.getDeleteFilter();
        if (deleteFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_delete");
        }

        const response = await this.prisma.delete({
            'where': {
                id: parseInt(id),
                ...deleteFilter
            },
            'select': this.select(),
            ...options
        });
        if(response){
            return response;
        }
        throw new ErrorResponse(403, "no_permission");
    }

    /**
     *
     * @param {string} q
     * @property {string|Object} include
     * @param {number} limit
     * @param {number} offset
     * @param {string} sortBy
     * @param {'asc'|'desc'} sortOrder
     * @returns {Promise<Object[]>}
     */
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc"){
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }
    /**
     * @param {number} id
     * @param {string | Object} include
     * @returns {Promise<{} | null>}
     */
    async get(id, include, options = {}){
        return await this._get(Number(id), include, options);
    }

    /**
     * @param {number} id
     * @param {{}} data
     * @returns {Promise<Object>}
     */
    async update(id, data, options = {}){
        return await this._update(Number(id), data, options);
    }

    /**
     *
     * @param {string} q
     * @returns {Promise<number>}
     */
    async count(q = {}) {
        return await this._count(q);
    }

    /**
     * @param {number} id
     * @returns {Promise<Object>}
     */
    async delete(id, data, options = {}){
        return await this._delete(Number(id), data, options);
    }

    select(fields){
        return this._select(fields);
    }
    filter(include){
        return {...this._filter(include), ...this.getAccessFilter()};
    }
    include(include){
        return this._include(include);
    }
    sort(sortBy, sortOrder) {
        return this.queryBuilder.sort(sortBy, sortOrder);
    }
    take(limit){
        return this.queryBuilder.take(Number(limit));
    }
    skip(offset){
        const parsed = parseInt(offset);
        if(isNaN(parsed) || parsed < 0){
            return 0;
        }
        return parsed;
    }

    /**
     *
     * @returns {Object}
     */
    getAccessFilter(){
        const filter = this._getAccessFilter()
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return this._getAccessFilter();
    }

    /**
     * Check if user can create records
     * @returns {boolean}
     */
    canCreate() {
        if(this.user.role == "application") return true;
        return this._canCreate();
    }

    /**
     * Get update filter for ACL
     * @returns {Object|false}
     */
    getUpdateFilter(){
        const filter = this._getUpdateFilter();
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return filter;
    }

    /**
     * Get delete filter for ACL
     * @returns {Object|false}
     */
    getDeleteFilter(){
        const filter = this._getDeleteFilter();
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return filter;
    }

    set modelName (name){
        this.name = name;
        this.prisma = prisma[name];
        this.fields = this.prisma.fields;
    }

    static relatedObjects = [];
    static Error = ErrorResponse;
}

module.exports = {Model, QueryBuilder, prisma};
`;

  // Ensure src directory exists
  const srcDir = path.dirname(modelJsPath);
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }

  fs.writeFileSync(modelJsPath, content);
  console.log('✓ Generated src/Model.js');
}

/**
 * Generate rapidd/rapidd.js file
 * @param {string} rapiddJsPath - Path to rapidd.js
 * @param {boolean} isPostgreSQL - Whether the database is PostgreSQL
 */
function generateRapiddFile(rapiddJsPath, isPostgreSQL = true) {
  let content;

  if (isPostgreSQL) {
    // PostgreSQL version with RLS support
    content = `const { PrismaClient } = require('../prisma/client');
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

// Basis Prisma Client
const basePrisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

/**
 * FIXED: Setze RLS Session Variables in PostgreSQL
 * Execute each SET command separately to avoid prepared statement error
 */
async function setRLSVariables(tx, userId, userRole) {
    const namespace = RLS_CONFIG.namespace;
    const userIdVar = RLS_CONFIG.userId;
    const userRoleVar = RLS_CONFIG.userRole;

    // Execute SET commands separately (PostgreSQL doesn't allow multiple commands in prepared statements)
    await tx.$executeRawUnsafe(\`SET LOCAL "\${namespace}"."\${userIdVar}" = '\${userId}'\`);
    await tx.$executeRawUnsafe(\`SET LOCAL "\${namespace}"."\${userRoleVar}" = '\${userRole}'\`);
}

// FIXED: Erweiterter Prisma mit automatischer RLS
const prisma = basePrisma.$extends({
    query: {
        async $allOperations({ operation, args, query, model }) {
            const context = requestContext.getStore();

            // Kein Context = keine RLS (z.B. System-Operationen)
            if (!context?.userId || !context?.userRole) {
                return query(args);
            }

            const { userId, userRole } = context;

            // IMPORTANT: The entire operation must happen in ONE transaction
            // We need to wrap the ENTIRE query execution in a single transaction

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
                // This is the key: we need to use the transaction client for the query
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

// Helper for batch operations in single transaction
async function prismaTransaction(operations) {
    const context = requestContext.getStore();
    
    if (!context?.userId || !context?.userRole) {
        return Promise.all(operations);
    }
    
    return basePrisma.$transaction(async (tx) => {
        await setRLSVariables(tx, context.userId, context.userRole);
        return Promise.all(operations.map(op => op(tx)));
    });
}

// Alternative approach: Manual transaction wrapper
class PrismaWithRLS {
    constructor() {
        this.client = basePrisma;
    }

    /**
     * Execute any Prisma operation with RLS context
     */
    async withRLS(userId, userRole, callback) {
        return this.client.$transaction(async (tx) => {
            // Execute SET commands separately to avoid prepared statement error
            await tx.$executeRawUnsafe(\`SET LOCAL app.current_user_id = '\${userId}'\`);
            await tx.$executeRawUnsafe(\`SET LOCAL app.current_user_role = '\${userRole}'\`);

            // Execute callback with transaction client
            return callback(tx);
        });
    }

    /**
     * Get a proxy client for a specific user
     * This wraps ALL operations in RLS context
     */
    forUser(userId, userRole) {
        const withRLS = this.withRLS.bind(this);
        const client = this.client;

        return new Proxy({}, {
            get(target, model) {
                // Return a proxy for the model
                return new Proxy({}, {
                    get(modelTarget, operation) {
                        // Return a function that wraps the operation
                        return async (args) => {
                            return withRLS(userId, userRole, async (tx) => {
                                return tx[model][operation](args);
                            });
                        };
                    }
                });
            }
        });
    }
}

const prismaWithRLS = new PrismaWithRLS();

/**
 * Express Middleware: Set RLS context from authenticated user
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
 * Helper: System-Operationen ohne RLS (für Cron-Jobs, etc.)
 */
async function withSystemAccess(callback) {
    // For system access, we might not want RLS at all
    // So we use the base client directly
    return callback(basePrisma);
}

/**
 * Helper: Als bestimmter User ausführen (für Tests)
 */
async function withUser(userId, userRole, callback) {
    return requestContext.run({ userId, userRole }, () => callback());
}

/**
 * Helper: Direct transaction with RLS for complex operations
 */
async function transactionWithRLS(userId, userRole, callback) {
    return basePrisma.$transaction(async (tx) => {
        // Set RLS context for this transaction - execute separately
        await tx.$executeRawUnsafe(\`SET LOCAL app.current_user_id = '\${userId}'\`);
        await tx.$executeRawUnsafe(\`SET LOCAL app.current_user_role = '\${userRole}'\`);

        // Execute callback with transaction client
        return callback(tx);
    });
}

/**
 * Helper: Hole RLS Config (für SQL Generation)
 */
function getRLSConfig() {
    return RLS_CONFIG;
}

// Example usage in route
/*
app.get('/api/users', authenticateUser, setRLSContext, async (req, res) => {
    // Option 1: Using extended prisma (automatic RLS)
    const users = await prisma.user.findMany();

    // Option 2: Using manual transaction
    const users = await transactionWithRLS(req.user.id, req.user.role, async (tx) => {
        return tx.user.findMany();
    });

    // Option 3: Using forUser helper
    const userPrisma = prismaWithRLS.forUser(req.user.id, req.user.role);
    const users = await userPrisma.user.findMany();

    res.json(users);
});
*/

module.exports = {
    prisma,
    prismaTransaction,
    basePrisma, // Export base for auth operations that don't need RLS
    PrismaClient,
    requestContext,
    setRLSContext,
    withSystemAccess,
    withUser,
    transactionWithRLS,
    prismaWithRLS,
    getRLSConfig,
    setRLSVariables,
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
async function updateRelationshipsForModel(filteredModels, relationshipsPath, prismaClientPath, schemaPath, usedDMMF) {
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
    await generateRelationshipsFromDMMF(prismaClientPath, tempPath);
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

  // Try to use Prisma DMMF first (if prisma generate has been run)
  let parsedData = null;
  const prismaClientPath = path.join(process.cwd(), 'prisma', 'client');
  let usedDMMF = false;

  try {
    parsedData = await parsePrismaDMMF(prismaClientPath);
    if (parsedData) {
      console.log('Using Prisma generated client (DMMF)');
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

  // Generate src/Model.js (base Model class) if it doesn't exist
  if (!fs.existsSync(modelJsPath)) {
    console.log('\nGenerating src/Model.js...');
    generateBaseModelFile(modelJsPath);
  }

  // Parse datasource to determine database type
  let datasource = { isPostgreSQL: true };  // Default to PostgreSQL
  try {
    datasource = parseDatasource(schemaPath);
  } catch (error) {
    console.warn('Could not parse datasource, assuming PostgreSQL:', error.message);
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
        await updateRelationshipsForModel(filteredModels, relationshipsPath, prismaClientPath, schemaPath, usedDMMF);
      } else {
        // Generate all relationships
        if (usedDMMF) {
          await generateRelationshipsFromDMMF(prismaClientPath, relationshipsPath);
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
