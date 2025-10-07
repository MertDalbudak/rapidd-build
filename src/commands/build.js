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
const {ErrorResponse} = require('./Api');

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
            throw new ErrorResponse(\`Parameter sortBy '\${sortBy}' is not a valid field of \${this.constructor.name}\`, 400);
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
        id = Number(id)
        // To determine if the record is inaccessible, either due to non-existence or insufficient permissions, two simultaneous queries are performed.
        const _response = this.prisma.findUnique({
            'where': {
                'id': id,
                ...this.getAccessFilter()
            },
            'include': this.include(include),
            'omit': {...this._omit(), ...omit},
            ..._options
        });

        const _checkExistence = this.prisma.findUnique({
            'where': {
                'id': id
            },
            'select': {
                'id': true
            }
        });

        const [response, checkExistence] = await Promise.all([_response, _checkExistence]);

        if(response == null){
            if(checkExistence == null){
                throw new ErrorResponse("Record not found", 404);
            }
            throw new ErrorResponse("No permission", 403);
        }
        if(response.id != checkExistence?.id){   // IN CASE access_filter CONTAINS id FIELD
            throw new ErrorResponse("No permission", 403);
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
 * Build models from Prisma schema
 * @param {Object} options - Build options
 * @param {string} options.schema - Path to Prisma schema file
 * @param {string} options.output - Output directory for generated models
 * @param {string} options.relationships - Path to relationships.json file
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

  console.log(`Found ${Object.keys(models).length} models`);

  // Generate model files
  generateAllModels(models, modelDir, modelJsPath);

  // Generate src/Model.js (base Model class)
  console.log('\nGenerating src/Model.js...');
  generateBaseModelFile(modelJsPath);

  // Generate rapidd/rapidd.js
  console.log('Generating rapidd/rapidd.js...');
  generateRapiddFile(rapiddJsPath);

  // Generate relationships.json
  console.log(`\nGenerating relationships.json...`);

  try {
    if (usedDMMF) {
      await generateRelationshipsFromDMMF(prismaClientPath, relationshipsPath);
    } else {
      generateRelationshipsFromSchema(schemaPath, relationshipsPath);
    }
    console.log(`✓ Relationships file generated at: ${relationshipsPath}`);
  } catch (error) {
    console.error('Failed to generate relationships.json:', error.message);
    console.log('Note: You may need to create relationships.json manually.');
  }

  // Generate RLS configuration
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

    await generateRLS(
      models,
      rlsPath,
      datasource.url,
      datasource.isPostgreSQL,
      options.userTable,
      relationships
    );
  } catch (error) {
    console.error('Failed to generate RLS:', error.message);
    console.log('Generating permissive RLS fallback...');
    await generateRLS(models, rlsPath, null, false, options.userTable, relationships);
  }

  // Generate routes
  generateAllRoutes(models, routesDir);

  return { models, enums };
}

module.exports = {
  buildModels
};
