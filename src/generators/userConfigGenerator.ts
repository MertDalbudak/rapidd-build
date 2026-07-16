import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate an optional `src/config/user.ts` default-user config stub.
 *
 * Defining a default user is NOT mandatory. When absent (or exporting null), the
 * framework falls back to an internal system user that bypasses ACL. Apps that want a
 * concrete identity for unauthenticated/internal calls — with an id/role that match
 * their own schema — export it here. Never overwrites an existing file.
 */
export function generateUserConfig(outputPath: string): void {
  if (fs.existsSync(outputPath)) {
    console.log('Skipped user.ts (exists)');
    return;
  }

  const code = `import type { RapiddUser } from '../types';
// Optional: uncomment to use the system user (bypasses ACL) as the default identity.
// import { createSystemUser } from '../index';

/**
 * Default user for requests without an authenticated user.
 *
 * - Return a real identity ({ id, role }) to have such requests go through ACL as
 *   that user. Use YOUR schema's id type and a valid role value.
 * - Return null (default) to fall back to the framework system user, which bypasses ACL.
 * - Return \`createSystemUser({ id: <auditId> })\` to make the default privileged.
 */
const defaultUser: RapiddUser | null = null;

export default defaultUser;
`;

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, code);
  console.log('Generated user.ts');
}
