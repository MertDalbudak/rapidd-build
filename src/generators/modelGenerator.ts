import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/types';

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
import type { ModelOptions, GetManyResult, UpsertManyOptions, UpsertManyResult } from '../types';

export class ${className} extends Model {
    constructor(options?: ModelOptions) {
        super('${modelName}', options);
    }

    async getMany(
        q: Record<string, any> = {},
        include: string | Record<string, any> = "",
        limit: number = 25,
        offset: number = 0,
        sortBy: string = this.defaultSortField,
        sortOrder: string = "asc",
        fields: string | null = null
    ): Promise<GetManyResult> {
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder, {}, fields);
    }

    /**
     * Fetch a single record by primary key
     */
    async get(id: string | number | Record<string, any>, include?: string | Record<string, any>, options: Record<string, any> = {}, fields: string | null = null): Promise<any> {
        return await this._get(id, include, options, fields);
    }

    /**
     * Create a new record
     */
    async create(data: Record<string, any>, options: Record<string, any> = {}): Promise<any> {
        return await this._create(data, options);
    }

    /**
     * Update an existing record by primary key
     */
    async update(id: string | number | Record<string, any>, data: Record<string, any>, options: Record<string, any> = {}): Promise<any> {
        return await this._update(id, data, options);
    }

    /**
     * Create or update a record based on unique key
     */
    async upsert(data: Record<string, any>, unique_key: string | string[] = this.primaryKey, options: Record<string, any> = {}): Promise<any> {
        return await this._upsert(data, unique_key, options);
    }

    /**
     * Create or update multiple records based on unique key
     * Performs atomic batch operations with optional transaction support
     */
    async upsertMany(
        data: Record<string, any>[],
        unique_key: string | string[] = this.primaryKey,
        prismaOptions: Record<string, any> = {},
        options: UpsertManyOptions = {}
    ): Promise<UpsertManyResult> {
        return await this._upsertMany(data, unique_key, prismaOptions, options);
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
