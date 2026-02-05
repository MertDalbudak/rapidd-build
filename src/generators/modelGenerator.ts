import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/prismaFilterBuilder';

/**
 * Convert model name to PascalCase class name
 */
function toClassName(modelName: string): string {
  return modelName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Generate a single model file (TypeScript)
 */
export function generateModelFile(modelName: string, _modelInfo: ModelInfo): string {
  const className = toClassName(modelName);

  return `import { Model } from '../orm/Model';
import { QueryBuilder, prisma } from '../orm/QueryBuilder';
import type { ModelOptions, GetManyResult } from '../types';

export class ${className} extends Model {
    constructor(options?: ModelOptions) {
        super('${modelName}', options);
    }

    async getMany(
        q: Record<string, unknown> = {},
        include: string | Record<string, unknown> = '',
        limit: number = 25,
        offset: number = 0,
        sortBy: string = 'id',
        sortOrder: 'asc' | 'desc' = 'asc'
    ): Promise<GetManyResult> {
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }

    async get(id: string | number, include?: string | Record<string, unknown>): Promise<Record<string, unknown>> {
        return await this._get(id, include);
    }

    async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await this._create(data);
    }

    async update(id: string | number, data: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await this._update(id, data);
    }

    async upsert(data: Record<string, unknown>, unique_key: string = this.primaryKey): Promise<Record<string, unknown>> {
        return await this._upsert(data, unique_key);
    }

    async delete(id: string | number): Promise<Record<string, unknown>> {
        return await this._delete(id);
    }

    filter(include: string | Record<string, unknown>): Record<string, unknown> {
        return { ...this._filter(include), ...this.getAccessFilter() };
    }

    include(include: string | Record<string, unknown>): Record<string, unknown> {
        return this._include(include);
    }

    static override QueryBuilder = new QueryBuilder('${modelName}');
}

export { QueryBuilder, prisma };
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

  // Generate individual model files
  for (const [modelName, modelInfo] of Object.entries(models)) {
    const modelCode = generateModelFile(modelName, modelInfo);
    const className = toClassName(modelName);
    const modelPath = path.join(modelDir, `${className}.ts`);
    fs.writeFileSync(modelPath, modelCode);
    console.log(`Generated model: ${className}.ts`);
  }

  // Generate index.ts for models
  const indexContent = generateModelsIndex(models);
  fs.writeFileSync(path.join(modelDir, 'index.ts'), indexContent);
  console.log('Generated models/index.ts');
}

/**
 * Generate index.ts that exports all models
 */
function generateModelsIndex(models: Record<string, ModelInfo>): string {
  const exports: string[] = [];

  for (const modelName of Object.keys(models)) {
    const className = toClassName(modelName);
    exports.push(`export { ${className} } from './${className}';`);
  }

  exports.push('');
  exports.push("export { QueryBuilder, prisma } from '../orm/QueryBuilder';");

  return exports.join('\n');
}
