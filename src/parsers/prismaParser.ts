import * as fs from 'fs';
import type { ModelInfo, ModelField, ModelRelation } from './types';

export interface ParsedSchema {
  models: Record<string, ModelInfo>;
  enums: Record<string, string[]>;
}

/**
 * Extract blocks (model or enum) with proper brace matching
 */
function extractBlocks(content: string, keyword: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  const regex = new RegExp(`${keyword}\\s+(\\w+)\\s*{`, 'g');
  let match;

  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const startIndex = match.index + match[0].length;
    let braceCount = 1;
    let endIndex = startIndex;

    // Find matching closing brace
    while (braceCount > 0 && endIndex < content.length) {
      if (content[endIndex] === '{') braceCount++;
      if (content[endIndex] === '}') braceCount--;
      endIndex++;
    }

    const body = content.substring(startIndex, endIndex - 1);
    blocks.push({ name, body });
  }

  return blocks;
}

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes', 'BigInt']);

/** Remove // comments, leaving string literals (e.g. @default("https://...")) intact */
function stripComments(content: string): string {
  return content.split('\n').map((line) => {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"' && line[i - 1] !== '\\') inString = !inString;
      else if (!inString && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

/** Field names from a block attribute's list: @@id([a, b(sort: Desc)], name: "x") → [a, b] */
function parseFieldList(line: string, attribute: string): string[] | null {
  const match = line.match(new RegExp(`^${attribute}\\(\\s*(?:fields:\\s*)?\\[([^\\]]+)\\]`));
  return match ? match[1].split(',').map((f) => f.replace(/\(.*$/, '').trim()).filter(Boolean) : null;
}

/** The arguments of a field's @relation(...) */
function parseRelationAttribute(attributes: string): Pick<ModelRelation, 'relationName' | 'relationFromFields' | 'relationToFields'> {
  const start = attributes.indexOf('@relation(');
  if (start === -1) return { relationFromFields: [], relationToFields: [] };
  let depth = 0;
  let end = start + '@relation'.length;
  for (; end < attributes.length; end++) {
    if (attributes[end] === '(') depth++;
    else if (attributes[end] === ')' && --depth === 0) break;
  }
  const args = attributes.slice(start + '@relation('.length, end);
  const list = (key: string) => {
    const m = args.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
    return m ? m[1].split(',').map((f) => f.trim()).filter(Boolean) : [];
  };
  const name = args.match(/^\s*"([^"]+)"/) ?? args.match(/name:\s*"([^"]+)"/);
  return { relationName: name?.[1], relationFromFields: list('fields'), relationToFields: list('references') };
}

/**
 * Parse a Prisma schema file without @prisma/internals (fallback).
 * A field is a relation only when its type is a model of the schema — enums and scalars
 * like BigInt are not.
 */
export function parsePrismaSchema(schemaPath: string): ParsedSchema {
  const schemaContent = stripComments(fs.readFileSync(schemaPath, 'utf-8'));

  const enums: Record<string, string[]> = {};
  for (const { name, body } of extractBlocks(schemaContent, 'enum')) {
    enums[name] = parseEnumValues(body);
  }

  const modelBlocks = extractBlocks(schemaContent, 'model');
  const modelNames = new Set(modelBlocks.map((block) => block.name));
  const models: Record<string, ModelInfo> = {};

  for (const { name, body } of modelBlocks) {
    const fields: Record<string, ModelField> = {};
    const relations: ModelRelation[] = [];
    let compositeKey: string[] | null = null;
    const uniqueFields: string[][] = [];
    let dbName: string | null = null;

    for (const line of body.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (line.startsWith('@@')) {
        compositeKey = parseFieldList(line, '@@id') ?? compositeKey;
        const unique = parseFieldList(line, '@@unique');
        if (unique) uniqueFields.push(unique);
        dbName = line.match(/^@@map\(\s*(?:name:\s*)?["']([^"']+)["']/)?.[1] ?? dbName;
        continue;
      }

      const fieldMatch = line.match(/^(\w+)\s+(Unsupported\([^)]*\)|\w+)(\[\]|\?)?\s*(.*)$/);
      if (!fieldMatch) continue;
      const [, fieldName, fieldType, modifier, attributes = ''] = fieldMatch;
      const isRelation = modelNames.has(fieldType);
      const kind = isRelation ? 'object' : enums[fieldType] ? 'enum' : SCALAR_TYPES.has(fieldType) ? 'scalar' : 'unsupported';

      fields[fieldName] = {
        type: fieldType,
        optional: modifier === '?',
        isArray: modifier === '[]',
        isRelation,
        isId: /@id\b/.test(attributes),
        isUnique: /@unique\b/.test(attributes),
        isUpdatedAt: /@updatedAt\b/.test(attributes),
        hasDefaultValue: /@default\(/.test(attributes),
        attributes,
        kind,
      };

      if (isRelation) {
        const relation = parseRelationAttribute(attributes);
        Object.assign(fields[fieldName], relation);
        relations.push({
          name: fieldName,
          type: fieldType,
          isArray: modifier === '[]',
          optional: modifier === '?',
          kind,
          ...relation,
        });
      }
    }

    models[name] = {
      name,
      fields,
      relations,
      compositeKey: compositeKey && compositeKey.length > 1 ? compositeKey : null,
      uniqueFields,
      dbName: dbName || name.toLowerCase(),
    };
  }

  return { models, enums };
}

/**
 * Parse enum values
 */
function parseEnumValues(enumBody: string): string[] {
  const values: string[] = [];
  const lines = enumBody.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('@@'));

  for (const line of lines) {
    const valueMatch = line.match(/^(\w+)/);
    if (valueMatch) {
      values.push(valueMatch[1]);
    }
  }

  return values;
}

/**
 * Use Prisma's DMMF (Data Model Meta Format) to get model information
 */
export async function parsePrismaDMMF(schemaPath: string): Promise<ParsedSchema | null> {
  try {
    const { getDMMF } = require('@prisma/internals');

    // Read schema directly to avoid getSchemaWithPath merging with prisma.config.ts
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

    const dmmf = await getDMMF({
      datamodel: [[schemaPath, schemaContent]]
    });

    const models: Record<string, ModelInfo> = {};

    for (const model of dmmf.datamodel.models) {
      // Extract composite key if present
      const compositeKey = model.primaryKey && model.primaryKey.fields && model.primaryKey.fields.length > 1
        ? model.primaryKey.fields
        : null;

      // Extract compound unique constraints
      const uniqueFields: string[][] = Array.isArray(model.uniqueFields) ? model.uniqueFields : [];

      models[model.name] = {
        name: model.name,
        fields: {},
        relations: [],
        compositeKey,
        uniqueFields,
        dbName: model.dbName || model.name.toLowerCase() // Use dbName from DMMF or default to lowercase
      };

      for (const field of model.fields) {
        models[model.name].fields[field.name] = {
          type: field.type,
          optional: !field.isRequired,
          isArray: field.isList,
          isRelation: field.kind === 'object',
          isId: field.isId || false,
          isUnique: field.isUnique || false,
          isUpdatedAt: field.isUpdatedAt || false,
          hasDefaultValue: field.hasDefaultValue || false
        };

        if (field.kind === 'object') {
          models[model.name].relations.push({
            name: field.name,
            type: field.type,
            isArray: field.isList,
            optional: !field.isRequired,
            relationName: field.relationName,
            relationFromFields: field.relationFromFields || [],
            relationToFields: field.relationToFields || [],
            kind: field.kind
          });

          // Also add these to the field object for consistency
          models[model.name].fields[field.name].relationName = field.relationName;
          models[model.name].fields[field.name].relationFromFields = field.relationFromFields || [];
          models[model.name].fields[field.name].relationToFields = field.relationToFields || [];
          models[model.name].fields[field.name].kind = field.kind;
        }
      }
    }

    return { models, enums: dmmf.datamodel.enums };
  } catch (error) {
    console.warn('Could not use getDMMF from @prisma/internals, falling back to schema parsing');
    console.warn('Error:', (error as Error).message);
    return null;
  }
}
