import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/types';

/** Columns that hold credentials — never returned by default */
const SENSITIVE = /^(password|passwd|pwd|hash|password_?hash|hashed_?password)$|secret|token$|_token|api_?key/i;

/** What @rapidd/core looks for when DB_USER_TABLE and DB_USER_PASSWORD_FIELD are not set */
const USER_MODEL_NAMES = ['user', 'users', 'account', 'accounts'];
const PASSWORD_FIELD_NAMES = ['password', 'hash', 'passwordhash', 'password_hash', 'passwd', 'pwd', 'hashed_password'];

/** The table users sign in with — no password column when they sign in elsewhere (LDAP, OIDC, ...) */
export interface UserTable {
  model: string;
  passwordField: string | null;
}

/** Credential-like scalar columns of a model (password hashes, secrets, tokens, API keys) */
export function sensitiveFields(modelInfo: ModelInfo): string[] {
  return Object.entries(modelInfo.fields)
    .filter(([name, field]) => !field.isRelation && SENSITIVE.test(name))
    .map(([name]) => name);
}

/**
 * The user table as @rapidd/core finds it: DB_USER_TABLE, else a model called user, users,
 * account or accounts — with its password column: DB_USER_PASSWORD_FIELD, else one called
 * password, hash, passwd, ... Null without such a model (users from identity providers only).
 */
export function findUserTable(models: Record<string, ModelInfo>, env: Record<string, string | undefined> = process.env): UserTable | null {
  const names = Object.keys(models);
  const table = env.DB_USER_TABLE;
  const model = table
    ? names.find((n) => n === table) ?? names.find((n) => n.toLowerCase() === table.toLowerCase())
    : USER_MODEL_NAMES.map((u) => names.find((n) => n.toLowerCase() === u)).find(Boolean);
  if (!model) {
    if (table) console.warn(`DB_USER_TABLE "${table}" is not a model of the schema — no user table rules in acl.ts`);
    return null;
  }

  const columns = Object.entries(models[model].fields).filter(([, field]) => !field.isRelation).map(([name]) => name);
  const configured = env.DB_USER_PASSWORD_FIELD;
  if (configured && columns.includes(configured)) return { model, passwordField: configured };
  if (configured) console.warn(`DB_USER_PASSWORD_FIELD "${configured}" is not a column of ${model} — looking for one by name`);
  return { model, passwordField: columns.find((name) => PASSWORD_FIELD_NAMES.includes(name.toLowerCase())) ?? null };
}

/** Same header as @rapidd/core's src/config/acl.ts template */
const HEADER = `/**
 * Access control — one entry per model. Every hook receives the signed-in user: whatever your
 * user table or identity provider gives (ids, flags, relations, groups). Rapidd assumes
 * nothing about it but \`id\`.
 *
 *   canCreate(user, data)     may the user create this record?          missing: yes
 *   getAccessFilter(user)     rows the user may read                     missing: all
 *   getUpdateFilter(user)     rows the user may update                   missing: all
 *   getDeleteFilter(user)     rows the user may delete                   missing: all
 *                             → true (all rows), false (none) or a Prisma where
 *   getOmitFields(user)       fields never returned to the user
 *   getWritableFields(user)   the only fields the user may write (null: all)
 *
 * @example
 * post: {
 *     getAccessFilter: (user) => (user.is_admin ? true : { author_id: user.id }),
 *     getUpdateFilter: (user) => ({ author_id: user.id }),
 *     getOmitFields: () => ['internal_notes'],
 * },
 *
 * Models without an entry follow ACL_DEFAULT: allow (unrestricted) or deny (closed).
 * Without sign-in (AUTH_PROVIDERS=none) the user is { id: null } — an ownership filter on
 * user.id would then match rows whose owner IS NULL.
 */
`;

/**
 * A model's starting point: every user may create, read, update and delete; credential columns
 * are never returned. The user table's password is not written through the API either.
 */
function modelEntry(name: string, modelInfo: ModelInfo, passwordField: string | null): string {
  const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  const hidden = [...new Set([...sensitiveFields(modelInfo), ...(passwordField ? [passwordField] : [])])];
  const lines = [
    `        ${key}: {`,
    '            canCreate: () => true,',
    '            getAccessFilter: () => true,',
    '            getUpdateFilter: () => true,',
    '            getDeleteFilter: () => true,',
  ];
  if (hidden.length > 0) {
    lines.push(passwordField
      ? '            // Credential columns: never returned'
      : '            // Credential columns: never returned (a required one stays writable)');
    lines.push(`            getOmitFields: () => [${hidden.map((f) => `'${f}'`).join(', ')}],`);
  }
  if (passwordField) {
    lines.push('            // The sign-in password: not written through the API, which would store it unhashed and');
    lines.push('            // let any user set any user\'s — set it in your own code with getAuth().hashPassword()');
    lines.push(`            getWritableFields: () => Object.keys(getFields('${name}')).filter((field) => field !== '${passwordField}'),`);
  }
  lines.push('        },');
  return lines.join('\n');
}

/** src/config/acl.ts with an entry for each of these models */
export function aclSource(models: Record<string, ModelInfo>, userTable: UserTable | null = null): string {
  const passwordOf = (name: string) => (name === userTable?.model ? userTable.passwordField : null);
  const entries = Object.entries(models).map(([name, info]) => modelEntry(name, info, passwordOf(name)));
  const body = entries.length > 0 ? `{\n${entries.join('\n')}\n    }` : '{}';
  const imports = ["import type { AclConfig } from '../types';"];
  if (Object.keys(models).some((name) => passwordOf(name))) imports.push("import { getFields } from '../core/dmmf';");
  return `${imports.join('\n')}\n\n${HEADER}const acl: AclConfig = {\n    model: ${body},\n};\n\nexport default acl;\n`;
}

/** An acl.ts without a single entry — the template create-project ships */
function hasNoEntries(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /\bmodel\s*:\s*\{\s*\}/.test(code);
}

/**
 * src/config/acl.ts — written when it is missing or has no entry yet. Once it has entries it is
 * the app's security code and is never changed: models added later follow ACL_DEFAULT until an
 * entry is written for them. `env` is where DB_USER_TABLE and DB_USER_PASSWORD_FIELD are read.
 */
export function generateACL(
  models: Record<string, ModelInfo>,
  outputPath: string,
  env: Record<string, string | undefined> = process.env
): void {
  if (fs.existsSync(outputPath) && !hasNoEntries(fs.readFileSync(outputPath, 'utf-8'))) {
    console.log('Skipped acl.ts (has entries — models without one follow ACL_DEFAULT)');
    return;
  }

  const userTable = findUserTable(models, env);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, aclSource(models, userTable));
  console.log(`Generated acl.ts: ${Object.keys(models).join(', ') || 'no models'}`);
  if (userTable?.passwordField) {
    console.log(`  ${userTable.model}.${userTable.passwordField} (sign-in password): never returned, not written through the API`);
  } else if (userTable) {
    console.log(`  ${userTable.model}: user table without a password column`);
  }
}
