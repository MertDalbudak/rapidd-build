const { buildModels } = require('./src/commands/build');
const { parsePrismaSchema, parsePrismaDMMF } = require('./src/parsers/prismaParser');
const { generateModelFile, generateAllModels } = require('./src/generators/modelGenerator');

module.exports = {
  buildModels,
  parsePrismaSchema,
  parsePrismaDMMF,
  generateModelFile,
  generateAllModels
};
