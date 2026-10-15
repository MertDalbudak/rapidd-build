import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parseEnv } from 'util';
import { parsePrismaSchema, parsePrismaDMMF } from '../parsers/prismaParser';
import { generateAllRoutes } from '../generators/routeGenerator';
import { generateACL } from '../generators/aclGenerator';
import { generateAllModels, assertDistinctClassNames } from '../generators/modelGenerator';
import { generateUserConfig } from '../generators/userConfigGenerator';
import type { ModelInfo } from '../parsers/types';

export interface BuildOptions {
  schema: string;
  output: string;
  /** One model, or several separated by commas */
  model?: string;
  only?: 'model' | 'route' | 'acl';
  /** Skip `prisma generate` (the client is already up to date) */
  skipGenerate?: boolean;
}

/**
 * The app's environment as @rapidd/core loads it: its env file (ENV_FILE, else .env) under the
 * process's own variables — DB_USER_TABLE and DB_USER_PASSWORD_FIELD usually live there
 */
function appEnv(): Record<string, string | undefined> {
  let fromFile: Record<string, string | undefined> = {};
  try {
    fromFile = parseEnv(fs.readFileSync(path.resolve(process.env.ENV_FILE || '.env'), 'utf-8'));
  } catch {
    // No env file
  }
  return { ...fromFile, ...process.env };
}

/**
 * Regenerate the Prisma client. The previous client is moved aside rather than deleted
 * first: if `prisma generate` fails, it is restored — the app keeps a working client —
 * and the build stops instead of generating code for a schema the client doesn't match.
 */
function regeneratePrismaClient(schemaPath: string): void {
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  // [^}] keeps the match inside the client generator block
  const outputMatch = schemaContent.match(/generator\s+client\s*\{[^}]*?output\s*=\s*"([^"]+)"/);
  const clientDir = outputMatch ? path.resolve(path.dirname(schemaPath), outputMatch[1]) : null;
  const backupDir = clientDir && fs.existsSync(clientDir) ? `${clientDir}.rapidd-backup` : null;
  if (clientDir && backupDir) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.renameSync(clientDir, backupDir);
  }

  console.log('\nRunning npx prisma generate...');
  try {
    execSync(`npx prisma generate --schema="${schemaPath}"`, {
      stdio: 'inherit',
      cwd: path.dirname(schemaPath)
    });
  } catch (_error) {
    if (clientDir && backupDir) {
      fs.rmSync(clientDir, { recursive: true, force: true });
      fs.renameSync(backupDir, clientDir);
      console.error(`Restored the previous Prisma client: ${clientDir}`);
    }
    throw new Error('prisma generate failed — fix the error above and run the build again');
  }
  if (backupDir) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  console.log('Prisma client generated successfully\n');
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
  const userConfigPath = path.join(configDir, 'user.ts');
  const routesDir = path.join(baseDir, 'routes', 'api', 'v1');

  console.log('Building Rapidd models...');
  console.log(`Schema: ${schemaPath}`);
  console.log(`Output: ${baseDir}`);

  // Check if schema file exists
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Prisma schema file not found at: ${schemaPath}`);
  }

  if (options.skipGenerate) {
    console.log('Skipped prisma generate (--skip-generate)');
  } else {
    regeneratePrismaClient(schemaPath);
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
  assertDistinctClassNames(models);

  // Filter models if --model option is provided (one, or several separated by commas)
  let filteredModels = models;
  if (options.model) {
    filteredModels = {};
    for (const requested of options.model.split(',').map((m) => m.trim()).filter(Boolean)) {
      const matchedModel = Object.keys(models).find(m => m.toLowerCase() === requested.toLowerCase());
      if (!matchedModel) {
        throw new Error(`Model "${requested}" not found in schema. Available models: ${Object.keys(models).join(', ')}`);
      }
      filteredModels[matchedModel] = models[matchedModel];
    }
    console.log(`Filtering to model(s): ${Object.keys(filteredModels).join(', ')}`);
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
    // The first acl.ts covers every model, whichever ones this build was asked for
    generateACL(models, aclPath, appEnv());
    generateUserConfig(userConfigPath);
  }

  // Generate routes
  if (shouldGenerate.route) {
    generateAllRoutes(filteredModels, routesDir, models);
  }

  return { models, enums };
}
