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

  // Skip if file already exists
  if (fs.existsSync(outputPath)) {
    console.log('Skipped acl.ts (exists)');
    return;
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, aclCode);
  console.log('Generated acl.ts');
}
