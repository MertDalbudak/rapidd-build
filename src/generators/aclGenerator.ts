import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/types';

/**
 * Generate permissive ACL entry for a single model
 */
function generateModelACL(modelName: string): string {
  return `        ${modelName}: {
            canCreate(_user: RapiddUser): boolean {
                return true;
            },
            getAccessFilter(_user: RapiddUser): Record<string, unknown> | boolean {
                return {};
            },
            getUpdateFilter(_user: RapiddUser): Record<string, unknown> | boolean | false {
                return {};
            },
            getDeleteFilter(_user: RapiddUser): Record<string, unknown> | boolean | false {
                return {};
            },
            getOmitFields(_user: RapiddUser): string[] {
                return [];
            },
            // Whitelist of writable fields for create/update payloads (null = unrestricted).
            // At the REST edge (strictWrites) non-writable fields are rejected with 403;
            // internal model calls silently strip them instead.
            getWritableFields(_user: RapiddUser): string[] | null {
                return null;
            },
        }`;
}

/**
 * Generate complete acl.ts file (TypeScript)
 */
export function generateACL(
  models: Record<string, ModelInfo>,
  outputPath: string
): void {
  const modelNames = Object.keys(models);

  let aclCode = `import type { AclConfig, RapiddUser } from '../types';

const acl: AclConfig = {
    model: {
`;

  aclCode += modelNames.map(modelName => generateModelACL(modelName)).join(',\n');

  aclCode += `
    },
};

export default acl;
`;

  // Skip if file already exists and has non-empty model config
  if (fs.existsSync(outputPath)) {
    const existing = fs.readFileSync(outputPath, 'utf-8');
    const modelBlockMatch = existing.match(/model:\s*\{([\s\S]*?)\}\s*,?\s*\}\s*;/);
    if (modelBlockMatch && modelBlockMatch[1].trim().length > 0) {
      console.log('Skipped acl.ts (exists with custom config)');
      return;
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, aclCode);
  console.log('Generated acl.ts');
}
