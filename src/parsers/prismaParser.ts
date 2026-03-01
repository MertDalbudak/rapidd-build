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

/**
 * Parse Prisma schema file and extract model information
 */
export function parsePrismaSchema(schemaPath: string): ParsedSchema {
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const models: Record<string, ModelInfo> = {};

  // Extract models with proper brace matching
  const modelBlocks = extractBlocks(schemaContent, 'model');
  for (const { name, body } of modelBlocks) {
    const fields = parseModelFields(body);
    const compositeKeyFields = parseCompositeKey(body);
    const dbName = parseMapDirective(body);

    // Mark composite key fields with isId
    if (compositeKeyFields) {
      for (const fieldName of compositeKeyFields) {
        if (fields[fieldName]) {
          fields[fieldName].isId = true;
        }
      }
    }

    models[name] = {
      name,
      fields,
      relations: parseModelRelations(body),
      compositeKey: compositeKeyFields,
      dbName: dbName || name.toLowerCase() // Default to lowercase model name
    };
  }

  // Extract enums
  const enums: Record<string, string[]> = {};
  const enumBlocks = extractBlocks(schemaContent, 'enum');
  for (const { name, body } of enumBlocks) {
    enums[name] = parseEnumValues(body);
  }

  return { models, enums };
}

/**
 * Parse composite key from @@id directive
 */
function parseCompositeKey(modelBody: string): string[] | null {
  const lines = modelBody.split('\n').map(line => line.trim());

  for (const line of lines) {
    // Match @@id([field1, field2, ...])
    const match = line.match(/^@@id\(\[([^\]]+)\]\)/);
    if (match) {
      const fieldsStr = match[1];
      return fieldsStr.split(',').map(f => f.trim());
    }
  }

  return null;
}

/**
 * Parse @@map directive to get database table name
 */
function parseMapDirective(modelBody: string): string | null {
  const lines = modelBody.split('\n').map(line => line.trim());

  for (const line of lines) {
    // Match @@map("table_name") or @@map('table_name')
    const match = line.match(/^@@map\(["']([^"']+)["']\)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Parse model fields from model body
 */
function parseModelFields(modelBody: string): Record<string, ModelField> {
  const fields: Record<string, ModelField> = {};
  const lines = modelBody.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('@@'));

  for (const line of lines) {
    // Skip relation fields and index definitions
    if (line.startsWith('//') || line.startsWith('@@')) continue;

    // Match field definition: fieldName Type modifiers
    const fieldMatch = line.match(/^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)?$/);
    if (fieldMatch) {
      const [, fieldName, fieldType, modifier, attributes] = fieldMatch;

      // Determine if it's a relation field (starts with uppercase)
      const isRelation = fieldType[0] === fieldType[0].toUpperCase() &&
                        !['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes'].includes(fieldType);

      fields[fieldName] = {
        type: fieldType,
        optional: modifier === '?',
        isArray: modifier === '[]',
        isRelation: isRelation,
        attributes: attributes || ''
      };
    }
  }

  return fields;
}

/**
 * Parse model relations
 */
function parseModelRelations(modelBody: string): ModelRelation[] {
  const relations: ModelRelation[] = [];
  const lines = modelBody.split('\n').map(line => line.trim()).filter(line => line);

  for (const line of lines) {
    if (line.startsWith('//') || line.startsWith('@@')) continue;

    const fieldMatch = line.match(/^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)?$/);
    if (fieldMatch) {
      const [, fieldName, fieldType, modifier] = fieldMatch;

      // Check if it's a relation (not a Prisma scalar type)
      const scalarTypes = ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes', 'BigInt'];
      const isRelation = !scalarTypes.includes(fieldType);

      if (isRelation) {
        relations.push({
          name: fieldName,
          type: fieldType,
          isArray: modifier === '[]',
          optional: modifier === '?'
        });
      }
    }
  }

  return relations;
}

/**
 * Parse enum values
 */
function parseEnumValues(enumBody: string): string[] {
  const values: string[] = [];
  const lines = enumBody.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));

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
    const { getDMMF, getSchemaWithPath } = require('@prisma/internals');

    // Use Prisma 7's schema loader (handles prisma.config.ts and multi-file schemas)
    const schemaResult = await getSchemaWithPath({
      schemaPath: { cliProvidedPath: schemaPath }
    });

    // Pass schemas as [filePath, content] tuples for Prisma 7 compatibility
    const dmmf = await getDMMF({
      datamodel: schemaResult.schemas
    });

    const models: Record<string, ModelInfo> = {};

    for (const model of dmmf.datamodel.models) {
      // Extract composite key if present
      const compositeKey = model.primaryKey && model.primaryKey.fields && model.primaryKey.fields.length > 1
        ? model.primaryKey.fields
        : null;

      models[model.name] = {
        name: model.name,
        fields: {},
        relations: [],
        compositeKey,
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
