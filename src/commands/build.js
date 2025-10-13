const fs = require('fs');
const path = require('path');
const { parsePrismaSchema, parsePrismaDMMF } = require('../parsers/prismaParser');
const { generateAllModels } = require('../generators/modelGenerator');
const { generateRelationshipsFromDMMF, generateRelationshipsFromSchema } = require('../generators/relationshipsGenerator');
const { generateRLS } = require('../generators/rlsGeneratorV2');
const { parseDatasource } = require('../parsers/datasourceParser');
const { generateAllRoutes } = require('../generators/routeGenerator');

/**
 * Generate src/Model.js base class file
 */
function generateBaseModelFile(modelJsPath) {
  const content = `const { QueryBuilder, prisma } = require("./QueryBuilder");
const {rls} = require('../../rapidd/rapidd');
const {ErrorResponse} = require('./Api');

class Model {
    /**
         * @param {string} name
         * @param {{'user': {}}} options
         */
    constructor(name, options){
        this.modelName = name;
        this.queryBuilder = new QueryBuilder(name);
        this.rls = rls.model[name] || {};
        this.options = options || {}
        this.user = this.options.user || {'id': 1, 'role': 'application'};
        this.user_id = this.user ? this.user.id : null;
    }

    _select = (fields) => this.queryBuilder.select(fields);
    _filter = (q) => this.queryBuilder.filter(q);
    _include = (include) => this.queryBuilder.include(include, this.user);
    // RLS METHODS
    _canCreate = () => this.rls?.canCreate?.(this.user);
    _hasAccess = (data) => this.rls?.hasAccess?.(data, this.user) || false;
    _getAccessFilter = () => this.rls?.getAccessFilter?.(this.user);
    _getUpdateFilter = () => this.rls?.getUpdateFilter?.(this.user);
    _getDeleteFilter = () => this.rls?.getDeleteFilter?.(this.user);
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
        return await this.prisma.findMany({
            'where': this.filter(q),
            'include': this.include(include),
            'take': take,
            'skip': skip,
            'orderBy': this.sort(sortBy, sortOrder),
            'omit': this._omit(),
            ...options
        });
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
     *
     * @param {*} data
     * @returns {boolean}
     */
    hasAccess(data) {
        return this.user.role == "application" ? true : this._hasAccess(data, this.user);
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
     * Get update filter for RLS
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
     * Get delete filter for RLS
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
 */
function generateRapiddFile(rapiddJsPath) {
  const content = `const { PrismaClient } = require('../prisma/client');
const { AsyncLocalStorage } = require('async_hooks');
const rls = require('./rls');

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
 * Setze RLS Session Variables in PostgreSQL
 */
async function setRLSVariables(tx, userId, userRole) {
    const namespace = RLS_CONFIG.namespace;
    const userIdVar = RLS_CONFIG.userId;
    const userRoleVar = RLS_CONFIG.userRole;

    await tx.$executeRawUnsafe(\`SET LOCAL \${namespace}.\${userIdVar} = '\${userId}'\`);
    await tx.$executeRawUnsafe(\`SET LOCAL \${namespace}.\${userRoleVar} = '\${userRole}'\`);
}

// Erweiterter Prisma mit automatischer RLS
const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ args, query }) {
      const context = requestContext.getStore();

      // Kein Context = keine RLS (z.B. System-Operationen)
      if (!context?.userId || !context?.userRole) {
        return query(args);
      }

      const { userId, userRole } = context;

      // Query in Transaction mit RLS ausführen
      return basePrisma.$transaction(async (tx) => {
        // Session-Variablen setzen
        await setRLSVariables(tx, userId, userRole);

        // Original Query ausführen
        return query(args);
      });
    },
  },
});

/**
 * Helper: System-Operationen ohne RLS (für Cron-Jobs, etc.)
 */
async function withSystemAccess(callback) {
  return requestContext.run(
    { userId: 'system', userRole: 'ADMIN' },
    callback
  );
}

/**
 * Helper: Als bestimmter User ausführen (für Tests)
 */
async function withUser(userId, userRole, callback) {
  return requestContext.run({ userId, userRole }, callback);
}

/**
 * Helper: Hole RLS Config (für SQL Generation)
 */
function getRLSConfig() {
  return RLS_CONFIG;
}

module.exports = {
  prisma,
  PrismaClient,
  requestContext,
  withSystemAccess,
  withUser,
  getRLSConfig,
  setRLSVariables,
  rls
};
`;

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
 * Update rls.js for a specific model
 */
async function updateRLSForModel(filteredModels, allModels, rlsPath, datasource, userTable, relationships, debug = false) {
  const { generateRLS } = require('../generators/rlsGeneratorV2');

  // Generate RLS for the filtered model (but pass all models for user table detection)
  const tempPath = rlsPath + '.tmp';
  await generateRLS(
    filteredModels,
    tempPath,
    datasource.url,
    datasource.isPostgreSQL,
    userTable,
    relationships,
    debug,
    allModels
  );

  // Read the generated RLS for the specific model
  const tempContent = fs.readFileSync(tempPath, 'utf8');
  fs.unlinkSync(tempPath);

  // Extract the model's RLS configuration
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
        const modelRls = tempContent.substring(modelStart, i + 1);
        break;
      }
    }
  }

  if (braceCount !== 0) {
    throw new Error(`Could not extract RLS for model ${modelName} - unmatched braces`);
  }

  const modelRls = tempContent.substring(modelStart, i + 1);

  // Read existing rls.js
  if (fs.existsSync(rlsPath)) {
    let existingContent = fs.readFileSync(rlsPath, 'utf8');

    // Check if model already exists in RLS
    const existingModelPattern = new RegExp(`${modelName}:\\s*\\{[\\s\\S]*?\\n    \\}(?=,|\\n)`);

    if (existingModelPattern.test(existingContent)) {
      // Replace existing model RLS
      existingContent = existingContent.replace(existingModelPattern, modelRls);
    } else {
      // Add new model RLS before the closing of rls.model
      // Find the last closing brace of a model object and add comma after it
      existingContent = existingContent.replace(
        /(\n    \})\n(\};)/,
        `$1,\n    ${modelRls}\n$2`
      );
    }

    fs.writeFileSync(rlsPath, existingContent);
    console.log(`✓ Updated RLS for model: ${modelName}`);
  } else {
    // If rls.js doesn't exist, create it with just this model
    await generateRLS(
      filteredModels,
      rlsPath,
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
  const rlsPath = path.join(rapiddDir, 'rls.js');
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
    rls: !options.only || options.only === 'rls',
    relationship: !options.only || options.only === 'relationship'
  };

  // Validate --only option
  if (options.only && !['model', 'route', 'rls', 'relationship'].includes(options.only)) {
    throw new Error(`Invalid --only value "${options.only}". Must be one of: model, route, rls, relationship`);
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

  // Generate rapidd/rapidd.js if it doesn't exist
  if (!fs.existsSync(rapiddJsPath)) {
    console.log('Generating rapidd/rapidd.js...');
    generateRapiddFile(rapiddJsPath);
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

  // Generate RLS configuration
  if (shouldGenerate.rls) {
    console.log(`\nGenerating RLS configuration...`);

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
      // Parse datasource from Prisma schema to get database URL
      const datasource = parseDatasource(schemaPath);

      // For non-PostgreSQL databases (MySQL, SQLite, etc.), generate permissive RLS
      if (!datasource.isPostgreSQL) {
        console.log(`${datasource.provider || 'Non-PostgreSQL'} database detected - generating permissive RLS...`);
        await generateRLS(models, rlsPath, null, false, options.userTable, relationships, options.debug);
      } else if (options.model) {
        // Update only specific model in rls.js
        await updateRLSForModel(filteredModels, models, rlsPath, datasource, options.userTable, relationships, options.debug);
      } else {
        // Generate RLS for all models
        await generateRLS(
          models,
          rlsPath,
          datasource.url,
          datasource.isPostgreSQL,
          options.userTable,
          relationships,
          options.debug
        );
      }
    } catch (error) {
      console.error('Failed to generate RLS:', error.message);
      console.log('Generating permissive RLS fallback...');
      // Pass null for URL and false for isPostgreSQL to skip database connection
      await generateRLS(models, rlsPath, null, false, options.userTable, relationships, options.debug);
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
