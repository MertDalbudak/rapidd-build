const fs = require('fs');
const path = require('path');

// Load .env file if it exists
try {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
} catch (e) {
  // dotenv not available, skip
}

/**
 * Parse datasource configuration from Prisma schema
 * @param {string} schemaPath - Path to Prisma schema file
 * @returns {Object} - Datasource configuration with resolved URL
 */
function parseDatasource(schemaPath) {
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

  // Extract url
  const urlMatch = datasourceBlock.match(/url\s*=\s*(.+)/);
  if (!urlMatch) {
    throw new Error('No url found in datasource block');
  }

  let url = urlMatch[1].trim();

  // Handle env() function
  const envMatch = url.match(/env\(["']([^"']+)["']\)/);
  if (envMatch) {
    const envVar = envMatch[1];
    url = process.env[envVar];

    if (!url) {
      throw new Error(`Environment variable ${envVar} is not defined`);
    }
  } else {
    // Remove quotes if present
    url = url.replace(/^["']|["']$/g, '');
  }

  // Detect PostgreSQL from provider OR from the actual connection URL
  // This is important because the schema might say "mysql" but DATABASE_URL could be postgresql://
  let isPostgreSQL = provider === 'postgresql' || provider === 'postgres';

  if (!isPostgreSQL && url) {
    // Check if URL starts with postgresql:// or postgres://
    isPostgreSQL = url.startsWith('postgresql://') || url.startsWith('postgres://');
  }

  // Explicitly detect MySQL to avoid false PostgreSQL detection
  const isMySQL = provider === 'mysql' || (url && url.startsWith('mysql://'));

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

module.exports = {
  parseDatasource
};
