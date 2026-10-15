import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate an optional `src/config/user.ts` default-user config stub.
 *
 * Defining a default user is NOT mandatory. When absent (or exporting null), model calls
 * without a user run as an internal system user that bypasses ACL (with sign-in off, requests
 * are the anonymous user { id: null }, under acl.ts). Apps that want a
 * concrete identity for unauthenticated/internal calls — with an id and attributes that
 * match their own schema — export it here. Never overwrites an existing file.
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
 * - Return a real identity ({ id, ... }) to have such requests go through ACL as that
 *   user — your user table's id type and whatever attributes src/config/acl.ts reads.
 * - Return null (default): model calls in your code without a user run as the framework
 *   system user, which bypasses ACL; with sign-in off (AUTH_PROVIDERS=none) requests are the
 *   anonymous user { id: null }, under src/config/acl.ts.
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
