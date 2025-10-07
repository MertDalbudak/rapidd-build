const fs = require('fs');
const path = require('path');

/**
 * Generate relationships.json from Prisma DMMF
 * @param {Object} models - Models object from parser
 * @param {string} outputPath - Path to output relationships.json
 */
function generateRelationships(models, outputPath) {
  const relationships = {};

  for (const [modelName, modelInfo] of Object.entries(models)) {
    relationships[modelName] = {};

    for (const relation of modelInfo.relations) {
      const relatedModel = models[relation.type];

      if (!relatedModel) {
        console.warn(`Warning: Related model ${relation.type} not found for ${modelName}.${relation.name}`);
        continue;
      }

      // Check if the related model has a composite primary key (many-to-many junction table)
      const compositeKeyFields = getCompositeKeyFromModel(relatedModel);

      // Only add field/fields if:
      // 1. Related model has composite key (junction table)
      // 2. It's a many relationship (array)
      // 3. The composite key includes this model's foreign key (proving it's a junction for this model)
      const currentModelFk = `${modelName.toLowerCase()}_id`;
      const isJunctionTable = compositeKeyFields &&
                             compositeKeyFields.length > 1 &&
                             relation.isArray &&
                             compositeKeyFields.includes(currentModelFk);

      if (isJunctionTable) {
        // Many-to-many relationship through junction table
        // Reorder fields so current model's field comes first
        const reorderedFields = reorderFieldsForModel(compositeKeyFields, modelName);

        relationships[modelName][relation.name] = {
          'object': relation.type,
          'field': compositeKeyFields.join('_'), // e.g., "course_id_teacher_id"
          'fields': reorderedFields
        };
      } else {
        // Simple one-to-one or one-to-many relationship
        // Find the foreign key field name
        const foreignKeyField = findForeignKeyField(relation, modelInfo, relatedModel);

        relationships[modelName][relation.name] = {
          'object': relation.type,
          'field': foreignKeyField || `${relation.type}_id` // Use actual FK or fallback to convention
        };
      }
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(relationships, null, 4));
  console.log('Generated relationships.json');
}

/**
 * Find the foreign key field for a relation
 * @param {Object} relation - Relation object
 * @param {Object} currentModel - Current model info
 * @param {Object} relatedModel - Related model info
 * @returns {string|null} - Foreign key field name
 */
function findForeignKeyField(relation, currentModel, relatedModel) {
  // If relation has relationFromFields, use it
  if (relation.relationFromFields && relation.relationFromFields.length > 0) {
    return relation.relationFromFields[0];
  }

  // For array relations (one-to-many from parent), look for the FK in the related model
  if (relation.isArray) {
    // Find which field in the related model points back to current model
    for (const [fieldName, fieldInfo] of Object.entries(relatedModel.fields)) {
      if (fieldInfo.relationName === relation.relationName &&
          fieldInfo.relationFromFields &&
          fieldInfo.relationFromFields.length > 0) {
        // This is the FK field in the related model
        return fieldInfo.relationFromFields[0];
      }
    }

    // Fallback: convention-based
    return `${relation.type}_id`;
  }

  // For singular relations (many-to-one), find the FK in current model
  for (const [fieldName, fieldInfo] of Object.entries(currentModel.fields)) {
    if (fieldInfo.relationName === relation.relationName &&
        fieldInfo.relationToFields &&
        fieldInfo.relationToFields.length > 0) {
      // Found the matching relation field, return its FK
      return fieldName;
    }
  }

  // Final fallback
  return `${relation.type}_id`;
}

/**
 * Get composite key fields from a model
 * @param {Object} modelInfo - Model information
 * @returns {Array|null} - Array of composite key field names or null
 */
function getCompositeKeyFromModel(modelInfo) {
  // First check if the model has a compositeKey property (from parser)
  if (modelInfo.compositeKey && modelInfo.compositeKey.length > 1) {
    return modelInfo.compositeKey;
  }

  // Fallback: check for fields marked with isId (for schema parser)
  const compositeFields = [];
  for (const [fieldName, fieldInfo] of Object.entries(modelInfo.fields)) {
    if (fieldInfo.isId && !fieldInfo.isRelation) {
      compositeFields.push(fieldName);
    }
  }

  // If we found multiple ID fields, it's a composite key
  if (compositeFields.length > 1) {
    return compositeFields;
  }

  return null;
}

/**
 * Reorder composite key fields so the current model's field comes first
 * @param {Array} fields - Array of field names
 * @param {String} currentModelName - Name of the current model
 * @returns {Array} - Reordered array with current model's field first
 */
function reorderFieldsForModel(fields, currentModelName) {
  const currentModelField = `${currentModelName.toLowerCase()}_id`;
  const index = fields.indexOf(currentModelField);

  if (index > 0) {
    // Move current model's field to the front
    const reordered = [...fields];
    reordered.splice(index, 1);
    reordered.unshift(currentModelField);
    return reordered;
  }

  return fields;
}

/**
 * Generate relationships.json from schema
 * @param {string} schemaPath - Path to Prisma schema file
 * @param {string} outputPath - Path to output relationships.json
 */
function generateRelationshipsFromSchema(schemaPath, outputPath) {
  const { parsePrismaSchema } = require('../parsers/prismaParser');
  const parsedData = parsePrismaSchema(schemaPath);
  generateRelationships(parsedData.models, outputPath);
}

/**
 * Generate relationships.json from DMMF
 * @param {string} prismaClientPath - Path to Prisma client
 * @param {string} outputPath - Path to output relationships.json
 */
async function generateRelationshipsFromDMMF(prismaClientPath, outputPath) {
  const { parsePrismaDMMF } = require('../parsers/prismaParser');
  const parsedData = await parsePrismaDMMF(prismaClientPath);
  generateRelationships(parsedData.models, outputPath);
}

module.exports = {
  generateRelationships,
  generateRelationshipsFromSchema,
  generateRelationshipsFromDMMF
};
