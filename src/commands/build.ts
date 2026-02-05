import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parsePrismaSchema, parsePrismaDMMF } from '../parsers/prismaParser';
import { parseDatasource } from '../parsers/datasourceParser';
import { generateAllModels } from '../generators/modelGenerator';
import { generateAllRoutes } from '../generators/routeGenerator';
import { generateACL } from '../generators/aclGenerator';
import type { ModelInfo, RelationshipInfo } from '../parsers/prismaFilterBuilder';

export interface BuildOptions {
  schema: string;
  output: string;
  model?: string;
  only?: 'model' | 'route' | 'acl';
  userTable?: string;
  debug?: boolean;
}

/**
 * Update acl.ts for a specific model
 */
async function updateACLForModel(
  filteredModels: Record<string, ModelInfo>,
  allModels: Record<string, ModelInfo>,
  aclPath: string,
  datasource: { url: string | null; isPostgreSQL: boolean },
  userTable: string | undefined,
  debug: boolean = false
): Promise<void> {
  // Generate ACL for the filtered model (but pass all models for user table detection)
  const tempPath = aclPath + '.tmp';
  await generateACL(
    filteredModels,
    tempPath,
    datasource.url,
    datasource.isPostgreSQL,
    userTable,
    {},
    debug,
    allModels
  );

  // Read the generated ACL for the specific model
  const tempContent = fs.readFileSync(tempPath, 'utf8');
  fs.unlinkSync(tempPath);

  // Extract the model's ACL configuration
  const modelName = Object.keys(filteredModels)[0];

  // Find the start of the model definition
  const modelStart = tempContent.indexOf(`${modelName}:`);
  if (modelStart === -1) {
    throw new Error(`Could not find model ${modelName} in generated RLS`);
  }

  // Find the matching closing brace by counting braces
  let braceCount = 0;
  let inString = false;
  let stringChar: string | null = null;
  let i = tempContent.indexOf('{', modelStart);

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
        break;
      }
    }
  }

  if (braceCount !== 0) {
    throw new Error(`Could not extract ACL for model ${modelName} - unmatched braces`);
  }

  const modelAcl = tempContent.substring(modelStart, i + 1);

  // Read existing acl.ts
  if (fs.existsSync(aclPath)) {
    let existingContent = fs.readFileSync(aclPath, 'utf8');

    // Check if model already exists in ACL
    const existingModelPattern = new RegExp(`${modelName}:\\s*\\{[\\s\\S]*?\\n        \\}(?=,|\\n)`);

    if (existingModelPattern.test(existingContent)) {
      // Replace existing model ACL
      existingContent = existingContent.replace(existingModelPattern, modelAcl);
    } else {
      // Add new model ACL before the closing of acl.model
      existingContent = existingContent.replace(
        /(\n        \})\n(\s*\},)/,
        `$1,\n        ${modelAcl}\n$2`
      );
    }

    fs.writeFileSync(aclPath, existingContent);
    console.log(`Updated ACL for model: ${modelName}`);
  } else {
    // If acl.ts doesn't exist, create it with just this model
    await generateACL(
      filteredModels,
      aclPath,
      datasource.url,
      datasource.isPostgreSQL,
      userTable,
      {},
      debug,
      allModels
    );
  }
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

  // Run npx prisma generate first
  console.log('\nRunning npx prisma generate...');
  try {
    execSync(`npx prisma generate --schema=${schemaPath}`, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    console.log('Prisma client generated successfully\n');
  } catch (_error) {
    console.warn('Warning: Failed to generate Prisma client');
    console.warn('Continuing with schema parsing fallback...\n');
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

  // Parse datasource to determine database type
  let datasource = { isPostgreSQL: true, url: null as string | null, provider: null as string | null, isMySQL: false };
  try {
    datasource = parseDatasource(schemaPath);
  } catch (error) {
    // Only warn if it's not the expected "No url found" error in Prisma 7
    if (!(error as Error).message.includes('No url found')) {
      console.warn('Could not parse datasource, assuming PostgreSQL:', (error as Error).message);
    }
  }

  // Generate ACL configuration
  if (shouldGenerate.acl) {
    console.log(`\nGenerating ACL configuration...`);

    try {
      // For non-PostgreSQL databases (MySQL, SQLite, etc.), generate permissive ACL
      if (!datasource.isPostgreSQL) {
        console.log(`${datasource.provider || 'Non-PostgreSQL'} database detected - generating permissive ACL...`);
        await generateACL(models, aclPath, null, false, options.userTable, {}, options.debug);
      } else if (options.model) {
        // Update only specific model in acl.ts
        await updateACLForModel(filteredModels, models, aclPath, datasource, options.userTable, options.debug);
      } else {
        // Generate ACL for all models
        await generateACL(
          models,
          aclPath,
          datasource.url,
          datasource.isPostgreSQL,
          options.userTable,
          {},
          options.debug
        );
      }
    } catch (error) {
      console.error('Failed to generate ACL:', (error as Error).message);
      console.log('Generating permissive ACL fallback...');
      // Pass null for URL and false for isPostgreSQL to skip database connection
      await generateACL(models, aclPath, null, false, options.userTable, {}, options.debug);
    }
  }

  // Generate routes
  if (shouldGenerate.route) {
    generateAllRoutes(filteredModels, routesDir);
  }

  return { models, enums };
}
