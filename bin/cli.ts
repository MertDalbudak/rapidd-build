#!/usr/bin/env node

import { Command } from 'commander';
import { buildModels, BuildOptions } from '../src/commands/build';
// Resolve package.json from dist/bin (published) or bin (dev via tsx)
let version = '0.0.0';
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    version = require('../../package.json').version;
} catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    version = require('../package.json').version;
}

const program = new Command();

program
  .name('rapidd')
  .description('Rapidd build tool for generating TypeScript model files from Prisma schema')
  .version(version);

program
  .command('build')
  .description('Build TypeScript model files, routes, and ACL from Prisma schema')
  .option('-s, --schema <path>', 'Path to Prisma schema file', process.env.PRISMA_SCHEMA_PATH || './prisma/schema.prisma')
  .option('-o, --output <path>', 'Output base directory', './')
  .option('-m, --model <name>', 'Generate/update only specific model (e.g., "account", "user")')
  .option('--only <component>', 'Generate only specific component: "model", "route", or "acl"')
  .action(async (options: BuildOptions) => {
    try {
      await buildModels(options);
      console.log('\n✓ Build completed successfully');
    } catch (error) {
      console.error('Error building models:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse(process.argv);
