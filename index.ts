// Main exports for @rapidd/build

// Commands
export { buildModels } from './src/commands/build';
export type { BuildOptions } from './src/commands/build';

// Parsers
export { parsePrismaSchema, parsePrismaDMMF } from './src/parsers/prismaParser';
export { parseDatasource } from './src/parsers/datasourceParser';
export { DeepSQLAnalyzer } from './src/parsers/deepSQLAnalyzer';
export { PrismaFilterBuilder } from './src/parsers/prismaFilterBuilder';
export { createEnhancedConverter } from './src/parsers/enhancedRLSConverter';
export { analyzeFunctions, generateMappingConfig } from './src/parsers/functionAnalyzer';

// Generators
export { generateModelFile, generateAllModels } from './src/generators/modelGenerator';
export { generateRouteFile, generateAllRoutes } from './src/generators/routeGenerator';
export { generateACL } from './src/generators/aclGenerator';

// Types
export type { ModelInfo, ModelField, ModelRelation, RelationshipInfo } from './src/parsers/prismaFilterBuilder';
export type { SQLFilter, SQLCondition, SQLAnalysis } from './src/parsers/deepSQLAnalyzer';
export type { DatasourceConfig } from './src/parsers/datasourceParser';
export type { ParsedSchema } from './src/parsers/prismaParser';
export type { EnhancedConverter } from './src/parsers/enhancedRLSConverter';
export type { FunctionMapping, FunctionAnalysisResult, MappingConfig } from './src/parsers/functionAnalyzer';
