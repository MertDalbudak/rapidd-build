#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const { buildModels } = require('../src/commands/build');

const program = new Command();

program
  .name('rapidd')
  .description('Rapidd build tool for generating model files from Prisma schema')
  .version('0.1.0');

program
  .command('build')
  .description('Build model files from Prisma schema')
  .option('-s, --schema <path>', 'Path to Prisma schema file', process.env.PRISMA_SCHEMA_PATH || './prisma/schema.prisma')
  .option('-o, --output <path>', 'Output base directory', './')
  .option('-m, --model <name>', 'Generate/update only specific model (e.g., "account", "user")')
  .option('--only <component>', 'Generate only specific component: "model", "route", "rls", or "relationship"')
  .option('--user-table <name>', 'Name of the user table for RLS (default: auto-detect from user/users)')
  .action(async (options) => {
    try {
      await buildModels(options);
      console.log('\n✓ Build completed successfully');
    } catch (error) {
      console.error('Error building models:', error.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
