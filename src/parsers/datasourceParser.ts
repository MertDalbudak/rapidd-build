import * as fs from 'fs';
import * as path from 'path';

// Load .env file if it exists
try {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
} catch (_e) {
  // dotenv not available, skip
}

export interface DatasourceConfig {
  provider: string | null;
  url: string | null;
  isPostgreSQL: boolean;
  isMySQL: boolean;
}

/**
 * Try to load DATABASE_URL from prisma.config.ts (Prisma 7)
 */
function loadUrlFromPrismaConfig(): string | null {
  const configPath = path.join(process.cwd(), 'prisma.config.ts');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');

    // Look for env('DATABASE_URL') or similar patterns
    const envMatch = configContent.match(/env\(['"]([^'"]+)['"]\)/);
    if (envMatch) {
      const envVar = envMatch[1];
      return process.env[envVar] || null;
    }

    // Look for direct URL assignment
    const urlMatch = configContent.match(/url:\s*['"]([^'"]+)['"]/);
    if (urlMatch) {
      return urlMatch[1];
    }
  } catch (_e) {
    // Failed to read config, return null
  }

  return null;
}

/**
 * Parse datasource configuration from Prisma schema
 */
export function parseDatasource(schemaPath: string): DatasourceConfig {
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

  // Extract datasource block
  const datasourceRegex = /datasource\s+\w+\s*{([^}]*)}/;
  const match = schemaContent.match(datasourceRegex);

  if (!match) {
    throw new Error('No datasource block found in Prisma schema');
  }

  const datasourceBlock = match[1];

  // Extract provider
  const providerMatch = datasourceBlock.match(/provider\s*=\s*"([^"]+)"/);
  const provider = providerMatch ? providerMatch[1] : null;

  // Try to extract url from schema first
  let url: string | null = null;
  const urlMatch = datasourceBlock.match(/url\s*=\s*(.+)/);

  if (urlMatch) {
    url = urlMatch[1].trim();

    // Handle env() function
    const envMatch = url.match(/env\(["']([^"']+)["']\)/);
    if (envMatch) {
      const envVar = envMatch[1];
      url = process.env[envVar] || null;
    } else {
      // Remove quotes if present
      url = url.replace(/^["']|["']$/g, '');
    }
  }

  // If no URL in schema, try prisma.config.ts (Prisma 7)
  if (!url) {
    url = loadUrlFromPrismaConfig();
  }

  // If still no URL, check DATABASE_URL environment variable directly
  if (!url) {
    url = process.env.DATABASE_URL || null;
  }

  // Detect PostgreSQL from provider OR from the actual connection URL
  let isPostgreSQL = provider === 'postgresql' || provider === 'postgres';

  if (!isPostgreSQL && url) {
    // Check if URL starts with postgresql:// or postgres://
    isPostgreSQL = url.startsWith('postgresql://') || url.startsWith('postgres://');
  }

  // Explicitly detect MySQL to avoid false PostgreSQL detection
  const isMySQL = provider === 'mysql' || (!!url && url.startsWith('mysql://'));

  // If it's MySQL, ensure isPostgreSQL is false
  if (isMySQL) {
    isPostgreSQL = false;
  }

  return {
    provider,
    url,
    isPostgreSQL,
    isMySQL
  };
}
