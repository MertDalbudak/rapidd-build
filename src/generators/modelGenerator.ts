import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/types';

/**
 * Convert model name to PascalCase class name
 */
export function toClassName(modelName: string): string {
  return modelName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Models must not share a class name (`user_role` and `UserRole` both become UserRole): one
 * src/models file would serve both, and a route would query the other table.
 */
export function assertDistinctClassNames(models: Record<string, ModelInfo>): void {
  const byClass = new Map<string, string[]>();
  for (const name of Object.keys(models)) {
    const className = toClassName(name);
    byClass.set(className, [...(byClass.get(className) ?? []), name]);
  }
  const clashes = [...byClass].filter(([, names]) => names.length > 1);
  if (clashes.length > 0) {
    throw new Error(clashes.map(([className, names]) => `Models ${names.join(' and ')} ${names.length === 2 ? 'both' : 'all'} become class ${className}`).join('; ')
      + ' — rename all but one in the schema (@@map keeps their table names)');
  }
}

/** Names the model file imports — a model class of that name would clash with them */
const TEMPLATE_IMPORTS = ['Model', 'QueryBuilder', 'ModelOptions'];

/**
 * Generate a single model file (TypeScript).
 * The CRUD methods are inherited from Model — re-declaring them here only froze old
 * signatures into every app (e.g. a delete() that dropped its options).
 */
export function generateModelFile(modelName: string, _modelInfo: ModelInfo): string {
  const className = toClassName(modelName);
  if (TEMPLATE_IMPORTS.includes(className)) return aliasedModelFile(modelName, className);

  return `import { Model } from '../orm/Model';
import { QueryBuilder, prisma } from '../orm/QueryBuilder';
import type { ModelOptions } from '../types';

/**
 * getMany, get, create, update, upsert, upsertMany, count and delete are inherited from
 * Model. Override one to customize it for ${className}, e.g.:
 *
 *     async create(data: Record<string, any>, options: Record<string, any> = {}): Promise<any> {
 *         return super.create({ ...data, source: 'api' }, options);
 *     }
 */
export class ${className} extends Model {
    constructor(options?: ModelOptions) {
        super('${modelName}', options);
    }

    static override QueryBuilder = new QueryBuilder('${modelName}');
}

export { QueryBuilder, prisma };
`;
}

/** The model file for a model named like one of the template's imports (`model Model`) */
function aliasedModelFile(modelName: string, className: string): string {
  return `import { Model as RapiddModel } from '../orm/Model';
import { QueryBuilder as RapiddQueryBuilder } from '../orm/QueryBuilder';
import type { ModelOptions as RapiddModelOptions } from '../types';

/** getMany, get, create, update, upsert, upsertMany, count and delete are inherited from Model */
export class ${className} extends RapiddModel {
    constructor(options?: RapiddModelOptions) {
        super('${modelName}', options);
    }

    static override QueryBuilder = new RapiddQueryBuilder('${modelName}');
}
`;
}

/**
 * Generate all model files
 */
export function generateAllModels(models: Record<string, ModelInfo>, modelDir: string): void {
  // Create model directory if it doesn't exist
  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true });
  }

  // Generate individual model files (skip existing)
  for (const [modelName, modelInfo] of Object.entries(models)) {
    const className = toClassName(modelName);
    const modelPath = path.join(modelDir, `${className}.ts`);
    if (fs.existsSync(modelPath)) {
      console.log(`Skipped model (exists): ${className}.ts`);
      continue;
    }
    const modelCode = generateModelFile(modelName, modelInfo);
    fs.writeFileSync(modelPath, modelCode);
    console.log(`Generated model: ${className}.ts`);
  }
}
