import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/types';

/** Columns that hold credentials — never returned by default */
const SENSITIVE = /^(password|passwd|pwd|hash|password_?hash|hashed_?password)$|secret|token$|_token|api_?key/i;

/** Credential-like scalar columns of a model (password hashes, secrets, tokens, API keys) */
export function sensitiveFields(modelInfo: ModelInfo): string[] {
  return Object.entries(modelInfo.fields)
    .filter(([name, field]) => !field.isRelation && SENSITIVE.test(name))
    .map(([name]) => name);
}

/**
 * Default rules of a model: every signed-in user may create, read, update and delete;
 * credential columns are hidden from responses (they stay writable — the ACL keeps
 * required write-only fields such as a password writable). Tighten them in the setup wizard.
 */
export function defaultModelRules(modelInfo: ModelInfo): Record<string, unknown> {
  const hidden = sensitiveFields(modelInfo);
  return {
    create: { '*': true },
    read: { '*': 'all' },
    update: { '*': 'all' },
    delete: { '*': 'all' },
    ...(hidden.length > 0 ? { hide: { '*': hidden } } : {}),
  };
}

/**
 * config/acl.json — rules for the models it does not have yet. Existing rules are never
 * changed, and a file that is not valid JSON is left alone.
 */
export function generateAclRules(models: Record<string, ModelInfo>, rulesPath: string): void {
  let rules: { roleField?: string; models: Record<string, unknown> } = { models: {} };
  if (fs.existsSync(rulesPath)) {
    try {
      rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
      if (!rules.models || typeof rules.models !== 'object') rules.models = {};
    } catch (error) {
      console.log(`Skipped acl.json (not valid JSON: ${(error as Error).message})`);
      return;
    }
  }
  const added = Object.keys(models).filter((name) => !(name in rules.models));
  if (added.length === 0) {
    console.log('Skipped acl.json (rules for every model exist)');
    return;
  }
  for (const name of added) rules.models[name] = defaultModelRules(models[name]);
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 4) + '\n');
  console.log(`Generated acl.json rules: ${added.join(', ')}`);
}

const ACL_TS = `import type { AclConfig } from '../types';

/**
 * Access control in code.
 *
 * The rules live in config/acl.json — edit them in the setup wizard (Access control), or by
 * hand: per model and role, which rows may be read, updated and deleted, whether records may
 * be created, and which fields are hidden or writable. Rapidd applies them to every model
 * they list; see the Access Control wiki.
 *
 * An entry in \`model\` below takes a model over with code, replacing its rules:
 *
 *     post: {
 *         getAccessFilter: (user) => user.role === 'admin' ? true : { author_id: user.id },
 *     },
 */
const acl: AclConfig = {
    model: {},
};

export default acl;
`;

/**
 * config/acl.json (rules for new models) and src/config/acl.ts for code overrides. An
 * existing acl.ts is the app's security code and is never changed.
 */
export function generateACL(
  models: Record<string, ModelInfo>,
  outputPath: string,
  rulesPath: string = path.join(path.dirname(outputPath), '..', '..', 'config', 'acl.json')
): void {
  generateAclRules(models, rulesPath);

  if (fs.existsSync(outputPath)) {
    console.log('Skipped acl.ts (exists)');
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, ACL_TS);
  console.log('Generated acl.ts');
}
