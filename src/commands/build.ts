import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parsePrismaSchema, parsePrismaDMMF } from '../parsers/prismaParser';
import { generateAllModels } from '../generators/modelGenerator';
import { generateAllRoutes } from '../generators/routeGenerator';
import { generateACL } from '../generators/aclGenerator';
import type { ModelInfo } from '../parsers/types';

export interface BuildOptions {
  schema: string;
  output: string;
  model?: string;
  only?: 'model' | 'route' | 'acl';
}

/**
 * Build models from Prisma schema
 */
export async function buildModels(options: BuildOptions): Promise<{ models: Record<string, ModelInfo>; enums: any }> {
  const schemaPath = path.resolve(process.cwd(), options.schema);
  const outputBase = path.resolve(process.cwd(), options.output);

  // If output is "/", use process.cwd() as the base
  const baseDir = options.output === '/' ? process.cwd() : outputBase;

  // Construct paths - TypeScript output structure
  const srcDir = path.join(baseDir, 'src');
  const modelDir = path.join(srcDir, 'models');
  const configDir = path.join(srcDir, 'config');
  const aclPath = path.join(configDir, 'acl.ts');
  const routesDir = path.join(baseDir, 'routes', 'api', 'v1');

  console.log('Building Rapidd models...');
  console.log(`Schema: ${schemaPath}`);
  console.log(`Output: ${baseDir}`);

  // Check if schema file exists
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Prisma schema file not found at: ${schemaPath}`);
  }

  // Clean Prisma client output directory if specified in schema
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const outputMatch = schemaContent.match(/generator\s+client\s*\{[\s\S]*?output\s*=\s*"([^"]+)"/);
  if (outputMatch) {
    const clientOutputDir = path.resolve(path.dirname(schemaPath), outputMatch[1]);
    if (fs.existsSync(clientOutputDir)) {
      fs.rmSync(clientOutputDir, { recursive: true });
      console.log(`Cleaned Prisma client output: ${clientOutputDir}`);
    }
  }

  // Run prisma generate to regenerate client
  console.log('\nRunning npx prisma generate...');
  try {
    execSync(`npx prisma generate --schema="${schemaPath}"`, {
      stdio: 'inherit',
      cwd: path.dirname(schemaPath)
    });
    console.log('Prisma client generated successfully\n');
  } catch (_error) {
    console.warn('Warning: Failed to generate Prisma client\n');
  }

  // Try to use Prisma DMMF first (using @prisma/internals getDMMF)
  let parsedData: { models: Record<string, ModelInfo>; enums: any } | null = null;

  try {
    parsedData = await parsePrismaDMMF(schemaPath);
    if (parsedData) {
      console.log('Using Prisma DMMF (via @prisma/internals)');
    }
  } catch (_error) {
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
    acl: !options.only || options.only === 'acl'
  };

  // Validate --only option
  if (options.only && !['model', 'route', 'acl'].includes(options.only)) {
    throw new Error(`Invalid --only value "${options.only}". Must be one of: model, route, acl`);
  }

  // Generate model files
  if (shouldGenerate.model) {
    generateAllModels(filteredModels, modelDir);
  }

  // Generate ACL configuration
  if (shouldGenerate.acl) {
    generateACL(filteredModels, aclPath);
  }

  // Generate routes
  if (shouldGenerate.route) {
    generateAllRoutes(filteredModels, routesDir, models);
  }

  return { models, enums };
}
