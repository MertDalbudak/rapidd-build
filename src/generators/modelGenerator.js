const fs = require('fs');
const path = require('path');

/**
 * Generate a single model file
 * @param {string} modelName - Name of the model
 * @param {Object} modelInfo - Model information from parser
 * @returns {string} - Generated model class code
 */
function generateModelFile(modelName, modelInfo) {
  // Capitalize first letter for class name
  const className = modelName.charAt(0).toUpperCase() + modelName.slice(1);

  return `const {Model, QueryBuilder, prisma} = require('../Model');

class ${className} extends Model {
    constructor(options){
        super('${className}', options);
    }

    /**
     * @param {string} q
     * @property {string|Object} include
     * @param {number} limit
     * @param {number} offset
     * @param {string} sortBy
     * @param {'asc'|'desc'} sortOrder
     * @returns {Object[]}
     */
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc"){
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }

    /**
     * @param {number} id
     * @param {string | Object} include
     * @returns {{} | null}
     */
    async get(id, include){
        return await this._get(Number(id), include);
    }

    /**
     * @param {Object} data
     * @returns  {Object}
     */
    async create(data){
        return await this._create(data);
    }

    /**
     * @param {number} id
     * @param {{}} data
     * @returns {Object}
     */
    async update(id, data){
        return await this._update(Number(id), data);
    }

    /**
     * @param {number} id
     * @returns {Object}
     */
    async delete(id){
        return await this._delete(Number(id));
    }

    /**
     * @param {string | Object} include
     * @returns {Object}
     */
    filter(include){
        return {...this._filter(include), ...this.getAccessFilter()};
    }

    /**
     * @param {string | Object} include
     * @returns {Object}
     */
    include(include){
        return this._include(include);
    }
}

module.exports = {${className}, QueryBuilder, prisma};
`;
}

/**
 * Map Prisma types to JavaScript types
 * @param {string} prismaType - Prisma field type
 * @returns {string} - JavaScript type
 */
function mapPrismaTypeToJS(prismaType) {
  const typeMap = {
    'String': 'string',
    'Int': 'number',
    'Float': 'number',
    'Decimal': 'number',
    'Boolean': 'boolean',
    'DateTime': 'Date',
    'Json': 'object',
    'Bytes': 'Buffer'
  };

  return typeMap[prismaType] || prismaType;
}

/**
 * Generate all model files
 * @param {Object} models - Models object from parser
 * @param {string} modelDir - Directory to output model files
 * @param {string} modelJsPath - Path to output Model.js
 */
function generateAllModels(models, modelDir, modelJsPath) {
  // Create model directory if it doesn't exist
  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true });
  }

  // Generate individual model files
  for (const [modelName, modelInfo] of Object.entries(models)) {
    const modelCode = generateModelFile(modelName, modelInfo);
    // Capitalize first letter for filename
    const className = modelName.charAt(0).toUpperCase() + modelName.slice(1);
    const modelPath = path.join(modelDir, `${className}.js`);
    fs.writeFileSync(modelPath, modelCode);
    console.log(`Generated model: ${className}.js`);
  }

  // Copy Model.js to output if it exists in the project
  const sourceModelJs = path.join(process.cwd(), 'Model.js');
  if (fs.existsSync(sourceModelJs)) {
    fs.copyFileSync(sourceModelJs, modelJsPath);
    console.log('Copied Model.js to output');
  } else {
    console.warn('Warning: Model.js not found in project root');
  }

  // Copy rapidd.js to output if it exists
  const sourceRapiddJs = path.join(process.cwd(), 'rapidd', 'rapidd.js');
  const outputRapiddDir = modelDir.replace(/src[\/\\]Model$/, 'rapidd');
  const outputRapiddJs = path.join(outputRapiddDir, 'rapidd.js');

  if (fs.existsSync(sourceRapiddJs)) {
    if (!fs.existsSync(outputRapiddDir)) {
      fs.mkdirSync(outputRapiddDir, { recursive: true });
    }
    fs.copyFileSync(sourceRapiddJs, outputRapiddJs);
    console.log('Copied rapidd.js to output');
  }
}

module.exports = {
  generateAllModels,
  generateModelFile
};
