// Main exports for @rapidd/build

// Commands
export { buildModels } from './src/commands/build';
export type { BuildOptions } from './src/commands/build';

// Parsers
export { parsePrismaSchema, parsePrismaDMMF } from './src/parsers/prismaParser';
export type { ParsedSchema } from './src/parsers/prismaParser';

// Generators
export { generateModelFile, generateAllModels } from './src/generators/modelGenerator';
export { generateRouteFile, generateAllRoutes } from './src/generators/routeGenerator';
export { generateACL } from './src/generators/aclGenerator';

// Types
export type { ModelInfo, ModelField, ModelRelation } from './src/parsers/types';
