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

  // An existing acl.ts is the app's security config: it is only ever replaced while its
  // model block is still empty. (Matching "custom content" instead could miss a valid file
  // — a trailing comment was enough — and overwrite it with the allow-all scaffold.)
  if (fs.existsSync(outputPath)) {
    const existing = fs.readFileSync(outputPath, 'utf-8');
    if (!/model\s*:\s*\{\s*\}/.test(existing)) {
      const missing = modelNames.filter((name) => !new RegExp(`\\b${name}\\s*:`).test(existing));
      console.log('Skipped acl.ts (exists)');
      if (missing.length > 0) {
        console.log(`  No ACL entry for: ${missing.join(', ')} — these fall back to ACL_DEFAULT`);
      }
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
