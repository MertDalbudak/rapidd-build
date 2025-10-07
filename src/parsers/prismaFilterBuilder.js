/**
 * Prisma Filter Builder for RLS
 * Generates correct Prisma filter syntax based on schema relationships
 */

class PrismaFilterBuilder {
  constructor(models, relationships) {
    this.models = models;
    this.relationships = relationships || {};

    // Find the user model
    this.userModel = null;
    this.userModelName = null;
    for (const [modelName, modelInfo] of Object.entries(models)) {
      if (modelName.toLowerCase() === 'user' || modelName.toLowerCase() === 'users') {
        this.userModel = modelInfo;
        this.userModelName = modelName;
        break;
      }
    }
  }

  /**
   * Build a Prisma filter from SQL RLS analysis
   * @param {string} modelName - The model to build filter for
   * @param {Object} analysis - SQL analysis from DeepSQLAnalyzer
   * @param {string} userVar - User variable name (default: 'user')
   * @returns {string} - Prisma filter code
   */
  buildFilter(modelName, analysis, userVar = 'user') {
    if (!analysis.filters || analysis.filters.length === 0) {
      return '{}';
    }

    const filters = [];
    const modelInfo = this.models[modelName];

    for (const filter of analysis.filters) {
      if (filter.type.startsWith('user_') || filter.type.startsWith('session_')) {
        // This is a user field comparison
        const userField = filter.userField || filter.type.replace(/^(user_|session_)/, '');

        // Skip role filters - they're runtime checks, not data filters
        if (filter.type === 'user_role' || userField === 'role') {
          continue;
        }

        const prismaFilter = this.buildUserFieldFilter(modelName, filter.field, userField, userVar);
        if (prismaFilter) {
          filters.push(prismaFilter);
        }
      } else {
        // Direct field comparison
        switch (filter.type) {
          case 'equal':
            const value = isNaN(filter.value) && filter.value !== 'true' && filter.value !== 'false'
              ? `'${filter.value}'`
              : filter.value;
            filters.push(`{ ${filter.field}: ${value} }`);
            break;
          case 'not_equal':
            filters.push(`{ ${filter.field}: { not: '${filter.value}' } }`);
            break;
          case 'is_null':
            filters.push(`{ ${filter.field}: null }`);
            break;
          case 'not_null':
            filters.push(`{ ${filter.field}: { not: null } }`);
            break;
          case 'in':
            filters.push(`{ ${filter.field}: { in: [${filter.values.join(', ')}] } }`);
            break;
        }
      }
    }

    // Check if there are role conditions
    const hasRoleConditions = analysis.conditions && analysis.conditions.some(c =>
      c.type === 'role_any' || c.type === 'role_equal'
    );

    // If we have role conditions with OR logic, generate conditional filter
    const hasOrLogic = analysis.sql && analysis.sql.includes(' OR ');
    if (hasRoleConditions && hasOrLogic && filters.length > 0) {
      // Generate: if (roleCheck) return {}; else return filter;
      const roleConditions = analysis.conditions.filter(c => c.type === 'role_any' || c.type === 'role_equal');
      const roleChecks = roleConditions.map(c => {
        if (c.type === 'role_any') {
          return `[${c.roles.map(r => `'${r}'`).join(', ')}].includes(${userVar}?.role)`;
        } else if (c.type === 'role_equal') {
          return `${userVar}?.role === '${c.role}'`;
        }
      }).filter(Boolean);

      const roleCheck = roleChecks.length > 1 ? `(${roleChecks.join(' || ')})` : roleChecks[0];
      const dataFilter = filters.length === 1 ? filters[0] : `{ AND: [${filters.join(', ')}] }`;

      return `if (${roleCheck}) { return {}; } return ${dataFilter};`;
    }

    if (filters.length === 0) {
      return '{}';
    }

    // Deduplicate filters
    const uniqueFilters = [...new Set(filters)];

    if (uniqueFilters.length === 1) {
      return uniqueFilters[0];
    }

    // Check if we need OR or AND
    if (hasOrLogic) {
      return `{ OR: [${uniqueFilters.join(', ')}] }`;
    }

    return `{ AND: [${uniqueFilters.join(', ')}] }`;
  }

  /**
   * Build filter for user field comparison (handles relationships)
   * @param {string} modelName - Current model name
   * @param {string} fieldName - Field being checked
   * @param {string} userField - User field to compare against
   * @param {string} userVar - User variable
   * @returns {string|null} - Prisma filter or null
   */
  buildUserFieldFilter(modelName, fieldName, userField, userVar) {
    const modelInfo = this.models[modelName];
    if (!modelInfo) return null;

    // Check if this field exists directly in the model
    const field = modelInfo.fields[fieldName];

    if (field && !field.isRelation) {
      // Direct field comparison
      const userFieldPath = this.convertToUserFieldPath(userField, userVar);
      return `{ ${fieldName}: ${userFieldPath} }`;
    }

    // Check if this is a relationship check
    // For example: checking if course has a student with student_id = user.student?.id
    const modelRelations = this.relationships[modelName] || {};

    // First pass: Look for junction table relationships (prioritize these)
    for (const [relationName, relationInfo] of Object.entries(modelRelations)) {
      const relatedModel = this.models[relationInfo.object];
      if (!relatedModel) continue;

      // Prioritize many-to-many through junction table
      // e.g., course -> students (course_student) where student_id = user.student?.id
      if (relationInfo.fields && relationInfo.fields.length > 1) {
        // This is a junction table relation
        // Check if one of the junction fields matches what we're looking for
        if (relationInfo.fields.includes(fieldName)) {
          const userFieldPath = this.convertToUserFieldPath(userField, userVar);
          return this.buildRelationFilter(
            relationName,
            relationInfo,
            fieldName,
            userFieldPath
          );
        }
      }
    }

    // Second pass: Look for regular relationships
    for (const [relationName, relationInfo] of Object.entries(modelRelations)) {
      const relatedModel = this.models[relationInfo.object];
      if (!relatedModel) continue;

      // Check if the related model has this field
      if (relatedModel.fields[fieldName] && !relatedModel.fields[fieldName].isRelation) {
        // Found it! Build a relation filter
        const userFieldPath = this.convertToUserFieldPath(userField, userVar);
        return this.buildRelationFilter(
          relationName,
          relationInfo,
          fieldName,
          userFieldPath
        );
      }
    }

    // Fallback: direct comparison
    const userFieldPath = this.convertToUserFieldPath(userField, userVar);
    return `{ ${fieldName}: ${userFieldPath} }`;
  }

  /**
   * Convert user field to proper path
   * Checks if user model actually has the field before converting to relation path
   * Examples:
   *   'id' -> 'user?.id'
   *   'student_id' (if exists on user) -> 'user?.student_id'
   *   'student_id' (if NOT exists on user) -> 'user.student?.id'
   * @param {string} userField - Field name like 'id', 'student_id', 'teacher_id'
   * @param {string} userVar - User variable name
   * @returns {string} - Proper user field path
   */
  convertToUserFieldPath(userField, userVar) {
    // Special case for 'id'
    if (userField === 'id') {
      return `${userVar}?.id`;
    }

    // Check if user model actually has this field
    if (this.userModel && this.userModel.fields) {
      const userHasField = this.userModel.fields[userField];

      if (userHasField && !userHasField.isRelation) {
        // User has this field directly - use it
        return `${userVar}?.${userField}`;
      }
    }

    // User doesn't have this field - check if it's a relation pattern
    if (userField.endsWith('_id')) {
      // Extract the relation name (e.g., 'student_id' -> 'student')
      const relationName = userField.slice(0, -3);

      // Check if user has this relation
      if (this.userModel && this.userModel.fields) {
        const userHasRelation = this.userModel.fields[relationName];
        if (userHasRelation && userHasRelation.isRelation) {
          // User has this relation - use relation path
          return `${userVar}.${relationName}?.id`;
        }
      }

      // Assume it's a relation even if we can't verify
      return `${userVar}.${relationName}?.id`;
    }

    // Default: direct field access
    return `${userVar}?.${userField}`;
  }

  /**
   * Build Prisma relation filter
   * @param {string} relationName - Name of the relation
   * @param {Object} relationInfo - Relation metadata
   * @param {string} fieldName - Field to filter on
   * @param {string} value - Value to compare
   * @returns {string} - Prisma filter
   */
  buildRelationFilter(relationName, relationInfo, fieldName, value) {
    // Determine if this is a one-to-many or many-to-many
    const relatedModel = this.models[relationInfo.object];

    if (!relatedModel) {
      return `{ ${relationName}: { some: { ${fieldName}: ${value} } } }`;
    }

    // Check if related model is a junction table (has composite key)
    const isJunctionTable = relationInfo.fields && relationInfo.fields.length > 1;

    if (isJunctionTable) {
      // Many-to-many through junction
      // e.g., { students: { some: { student_id: user?.student_id } } }
      return `{ ${relationName}: { some: { ${fieldName}: ${value} } } }`;
    }

    // One-to-many or one-to-one
    // Check if relationName is plural (array) -> use 'some'
    if (relationName.endsWith('s') || relationInfo.fields) {
      return `{ ${relationName}: { some: { ${fieldName}: ${value} } } }`;
    }

    // Singular relation (one-to-one or many-to-one)
    return `{ ${relationName}: { ${fieldName}: ${value} } }`;
  }

  /**
   * Infer relation type from model data
   * @param {Object} modelInfo - Model information
   * @param {string} relationName - Relation name
   * @returns {string} - 'one' | 'many'
   */
  inferRelationType(modelInfo, relationName) {
    if (!modelInfo || !modelInfo.relations) return 'one';

    const relation = modelInfo.relations.find(r => r.name === relationName);
    return relation && relation.isArray ? 'many' : 'one';
  }

  /**
   * Build JavaScript equivalent of Prisma filter (for hasAccess)
   * @param {string} modelName - The model name
   * @param {Object} analysis - SQL analysis from DeepSQLAnalyzer
   * @param {string} dataVar - Data variable name
   * @param {string} userVar - User variable name
   * @returns {string} - JavaScript condition
   */
  buildJavaScriptCondition(modelName, analysis, dataVar = 'data', userVar = 'user') {
    const conditions = [];
    const modelInfo = this.models[modelName];

    for (const filter of analysis.filters) {
      if (filter.type.startsWith('user_') || filter.type.startsWith('session_')) {
        const userField = filter.userField || filter.type.replace(/^(user_|session_)/, '');

        // Skip role filters - they're handled in conditions section
        if (filter.type === 'user_role' || userField === 'role') {
          continue;
        }

        const jsCondition = this.buildUserFieldJavaScript(modelName, filter.field, userField, dataVar, userVar);
        if (jsCondition) {
          conditions.push(jsCondition);
        }
      } else {
        // Direct field comparison
        switch (filter.type) {
          case 'equal':
            const value = isNaN(filter.value) && filter.value !== 'true' && filter.value !== 'false'
              ? `'${filter.value}'`
              : filter.value;
            conditions.push(`${dataVar}?.${filter.field} === ${value}`);
            break;
        }
      }
    }

    // Add condition-based checks (roles, etc.)
    if (analysis.conditions && analysis.conditions.length > 0) {
      for (const condition of analysis.conditions) {
        if (condition.javascript) {
          // Replace user placeholder with actual variable
          const jsCondition = condition.javascript.replace(/user/g, userVar);
          conditions.push(jsCondition);
        } else if (condition.type === 'role_any') {
          conditions.push(`[${condition.roles.map(r => `'${r}'`).join(', ')}].includes(${userVar}?.role)`);
        } else if (condition.type === 'role_equal') {
          conditions.push(`${userVar}?.role === '${condition.role}'`);
        }
      }
    }

    if (conditions.length === 0) return 'true';

    // Deduplicate conditions
    const uniqueConditions = [...new Set(conditions)];

    if (uniqueConditions.length === 1) return uniqueConditions[0];

    // Check if we need OR or AND
    const hasOrLogic = analysis.sql && analysis.sql.includes(' OR ');
    if (hasOrLogic) {
      return uniqueConditions.join(' || ');
    }

    return '(' + uniqueConditions.join(' && ') + ')';
  }

  /**
   * Build JavaScript condition for user field (handles relations)
   * @param {string} modelName - Current model name
   * @param {string} fieldName - Field being checked
   * @param {string} userField - User field to compare against
   * @param {string} dataVar - Data variable name
   * @param {string} userVar - User variable name
   * @returns {string|null} - JavaScript condition
   */
  buildUserFieldJavaScript(modelName, fieldName, userField, dataVar, userVar) {
    const modelInfo = this.models[modelName];
    if (!modelInfo) return null;

    // Check if this field exists directly in the model
    const field = modelInfo.fields[fieldName];

    if (field && !field.isRelation) {
      // Direct field comparison
      const userFieldPath = this.convertToUserFieldPath(userField, userVar);
      return `${dataVar}?.${fieldName} === ${userFieldPath}`;
    }

    // Field doesn't exist directly - check relationships
    const modelRelations = this.relationships[modelName] || {};

    // First pass: Look for junction table relationships (prioritize these)
    for (const [relationName, relationInfo] of Object.entries(modelRelations)) {
      const relatedModel = this.models[relationInfo.object];
      if (!relatedModel) continue;

      // Prioritize many-to-many through junction table
      if (relationInfo.fields && relationInfo.fields.length > 1) {
        if (relationInfo.fields.includes(fieldName)) {
          const userFieldPath = this.convertToUserFieldPath(userField, userVar);
          // Generate: data?.students?.find(s => s.student_id === user.student?.id)
          return `${dataVar}?.${relationName}?.find(item => item.${fieldName} === ${userFieldPath})`;
        }
      }
    }

    // Second pass: Look for regular relationships
    for (const [relationName, relationInfo] of Object.entries(modelRelations)) {
      const relatedModel = this.models[relationInfo.object];
      if (!relatedModel) continue;

      // Check if the related model has this field
      if (relatedModel.fields[fieldName] && !relatedModel.fields[fieldName].isRelation) {
        const userFieldPath = this.convertToUserFieldPath(userField, userVar);

        // Check if this is an array relation (1:n or n:m)
        if (relationName.endsWith('s') || (relationInfo.fields && relationInfo.fields.length > 1)) {
          // Use .find() for array relations
          return `${dataVar}?.${relationName}?.find(item => item.${fieldName} === ${userFieldPath})`;
        } else {
          // Singular relation
          return `${dataVar}?.${relationName}?.${fieldName} === ${userFieldPath}`;
        }
      }
    }

    // Fallback: direct comparison
    const userFieldPath = this.convertToUserFieldPath(userField, userVar);
    return `${dataVar}?.${fieldName} === ${userFieldPath}`;
  }
}

module.exports = PrismaFilterBuilder;