const fs = require('fs');
const path = require('path');

/**
 * Extract blocks (model or enum) with proper brace matching
 * @param {string} content - Schema content
 * @param {string} keyword - 'model' or 'enum'
 * @returns {Array} - Array of {name, body} objects
 */
function extractBlocks(content, keyword) {
  const blocks = [];
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
 * @param {string} schemaPath - Path to Prisma schema file
 * @returns {Object} - Object containing models and their fields
 */
function parsePrismaSchema(schemaPath) {
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const models = {};

  // Extract models with proper brace matching
  const modelBlocks = extractBlocks(schemaContent, 'model');
  for (const { name, body } of modelBlocks) {
    const fields = parseModelFields(body);
    const compositeKeyFields = parseCompositeKey(body);

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
      compositeKey: compositeKeyFields
    };
  }

  // Extract enums
  const enums = {};
  const enumBlocks = extractBlocks(schemaContent, 'enum');
  for (const { name, body } of enumBlocks) {
    enums[name] = parseEnumValues(body);
  }

  return { models, enums };
}

/**
 * Parse composite key from @@id directive
 * @param {string} modelBody - The content inside model braces
 * @returns {Array|null} - Array of field names in composite key, or null
 */
function parseCompositeKey(modelBody) {
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
 * Parse model fields from model body
 * @param {string} modelBody - The content inside model braces
 * @returns {Object} - Field definitions
 */
function parseModelFields(modelBody) {
  const fields = {};
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
 * @param {string} modelBody - The content inside model braces
 * @returns {Array} - Array of relation definitions
 */
function parseModelRelations(modelBody) {
  const relations = [];
  const lines = modelBody.split('\n').map(line => line.trim()).filter(line => line);

  for (const line of lines) {
    if (line.startsWith('//') || line.startsWith('@@')) continue;

    const fieldMatch = line.match(/^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)?$/);
    if (fieldMatch) {
      const [, fieldName, fieldType, modifier, attributes] = fieldMatch;

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
 * @param {string} enumBody - The content inside enum braces
 * @returns {Array} - Array of enum values
 */
function parseEnumValues(enumBody) {
  const values = [];
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
 * Use Prisma's generated DMMF (Data Model Meta Format) to get model information
 * This is an alternative approach that uses Prisma's own abstraction
 * @param {string} prismaClientPath - Path to generated Prisma Client
 * @returns {Object} - Models extracted from DMMF
 */
async function parsePrismaDMMF(prismaClientPath) {
  try {
    // Try to load the generated Prisma Client
    const prismaClient = require(prismaClientPath);
    const dmmf = prismaClient.Prisma.dmmf;

    const models = {};

    for (const model of dmmf.datamodel.models) {
      // Extract composite key if present
      const compositeKey = model.primaryKey && model.primaryKey.fields && model.primaryKey.fields.length > 1
        ? model.primaryKey.fields
        : null;

      models[model.name] = {
        name: model.name,
        fields: {},
        relations: [],
        compositeKey
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
            optional: !field.isRequired
          });
        }
      }
    }

    return { models, enums: dmmf.datamodel.enums };
  } catch (error) {
    console.warn('Could not load Prisma Client DMMF, falling back to schema parsing');
    return null;
  }
}

module.exports = {
  parsePrismaSchema,
  parsePrismaDMMF
};
