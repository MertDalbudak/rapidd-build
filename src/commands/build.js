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
const {ErrorResponse, getTranslation} = require('./Api');

class Model {
    /**
         * @param {string} name
         * @param {{'user': {}}} options
         */
    constructor(name, options){
        this.modelName = name;
        this.options = options || {}
        this.user = this.options.user || {'id': 1, 'role': 'application'};
        this.user_id = this.user ? this.user.id : null;
    }

    _select = (fields) => this.constructor.queryBuilder.select(fields);
    _filter = (q) => this.constructor.queryBuilder.filter(q);
    _include = (include) => this.constructor.queryBuilder.include(include, this.user);
    _getAccessFilter = () => this.constructor.getAccessFilter(this.user);
    _hasAccess = (data) => this.constructor.hasAccess(data, this.user) || false;
    _omit = () => this.constructor.queryBuilder.omit(this.user);

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
            const message = getTranslation("invalid_sort_field", {sortBy, modelName: this.constructor.name});
            throw new ErrorResponse(message, 400);
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
        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.create(data, this.user_id);

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
        // GET DATA FIRST
        const current_data = await this._get(id, "ALL");

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.update(id, data, this.user_id);
        return await this.prisma.update({
            'where': {
                'id': id
            },
            'data': data,
            'include': this.include('ALL'),
            ...options
        });
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
        // GET DATA FIRST
        const current_data = await this._get(id);

        return await this.prisma.delete({
            'where': {
                id: parseInt(id)
            },
            'select': this.select(),
            ...options
        });
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
        return this.constructor.queryBuilder.sort(sortBy, sortOrder);
    }
    take(limit){
        return this.constructor.queryBuilder.take(Number(limit));
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
        if(this.user.role == "application" || filter == true){
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
  const content = `const { PrismaClient, Prisma } = require('../prisma/client');
const rls = require('./rls');

const prisma = new PrismaClient();

module.exports = {prisma, Prisma, rls};
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

      if (options.model) {
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
      if (!options.model) {
        console.log('Generating permissive RLS fallback...');
        await generateRLS(models, rlsPath, null, false, options.userTable, relationships, options.debug);
      }
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
