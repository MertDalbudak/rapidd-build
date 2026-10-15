import * as fs from 'fs';
import * as path from 'path';
import type { ModelInfo } from '../parsers/types';

/**
 * Convert model name to PascalCase class name
 */
function toClassName(modelName: string): string {
  return modelName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// ─── Junction table detection ────────────────────────────────────────

interface ParentRelation {
  fkField: string;
  parentModel: string;
}

interface JunctionInfo {
  isJunction: boolean;
  parentRelations: ParentRelation[];
}

/**
 * Detect if a model is a junction (n:m) table.
 * A junction table has a composite key with exactly 2 fields, each a foreign key to a
 * parent: it is served under its parents. A key of 3 or more fields is a route of its own
 * (/:id = "a~b~c").
 */
function detectJunctionTable(_modelName: string, modelInfo: ModelInfo): JunctionInfo {
  if (!modelInfo.compositeKey || modelInfo.compositeKey.length !== 2) {
    return { isJunction: false, parentRelations: [] };
  }

  // Map each composite key field to its parent relation
  const parentRelations: ParentRelation[] = [];
  for (const keyField of modelInfo.compositeKey) {
    const rel = modelInfo.relations.find(r =>
      r.relationFromFields && r.relationFromFields.includes(keyField)
    );
    if (rel) {
      parentRelations.push({
        fkField: keyField,
        parentModel: rel.type,
      });
    }
  }

  // Both composite key fields must map to parent relations
  return {
    isJunction: parentRelations.length === 2,
    parentRelations,
  };
}

/**
 * Normalise a word for prefix comparison (strip trailing plural 's'/'es').
 */
function singularize(word: string): string {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes') || word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * Derive sub-route name by stripping the common leading word(s)
 * between parent model name and junction table name.
 * Handles plural/singular differences (e.g. "messages" vs "message_attachments").
 */
function computeSubRouteName(parentName: string, junctionName: string): string {
  const parentWords = parentName.split('_');
  const junctionWords = junctionName.split('_');

  let commonCount = 0;
  for (let i = 0; i < Math.min(parentWords.length, junctionWords.length); i++) {
    if (singularize(parentWords[i]) === singularize(junctionWords[i])) {
      commonCount++;
    } else {
      break;
    }
  }

  if (commonCount > 0 && commonCount < junctionWords.length) {
    return junctionWords.slice(commonCount).join('_');
  }

  return junctionName;
}

export interface SubRouteInfo {
  junctionModelName: string;
  junctionModelInfo: ModelInfo;
  subRouteName: string;
  fkFieldToParent: string;
  otherFkField: string;
}

interface JunctionMap {
  junctionModels: Set<string>;
  parentSubRoutes: Map<string, SubRouteInfo[]>;
}

/**
 * Analyse all models and build the junction / parent-sub-route map.
 */
function buildJunctionMap(models: Record<string, ModelInfo>): JunctionMap {
  const junctionModels = new Set<string>();
  const parentSubRoutes = new Map<string, SubRouteInfo[]>();

  for (const [modelName, modelInfo] of Object.entries(models)) {
    const junction = detectJunctionTable(modelName, modelInfo);
    if (!junction.isJunction) continue;

    junctionModels.add(modelName);

    for (let i = 0; i < junction.parentRelations.length; i++) {
      const parentRel = junction.parentRelations[i];
      const otherRels = junction.parentRelations.filter((_, j) => j !== i);
      if (!models[parentRel.parentModel]) continue;

      if (!parentSubRoutes.has(parentRel.parentModel)) {
        parentSubRoutes.set(parentRel.parentModel, []);
      }
      const list = parentSubRoutes.get(parentRel.parentModel)!;
      const subRouteName = computeSubRouteName(parentRel.parentModel, modelName);
      // Self-referential n:m (both FKs point to the same parent) yields two identical entries —
      // emit ONE sub-route (scoped by the first FK), else the generated parent index has a
      // duplicate import/register (TS2300) and a duplicate Fastify route registration.
      if (list.some((sr) => sr.subRouteName === subRouteName)) continue;
      list.push({
        junctionModelName: modelName,
        junctionModelInfo: modelInfo,
        subRouteName,
        fkFieldToParent: parentRel.fkField,
        otherFkField: otherRels[0].fkField,
      });
    }
  }

  // Remove sub-route entries where the parent is itself a junction table
  for (const parentModel of parentSubRoutes.keys()) {
    if (junctionModels.has(parentModel)) {
      parentSubRoutes.delete(parentModel);
    }
  }

  return { junctionModels, parentSubRoutes };
}

// ─── Route file generators ──────────────────────────────────────────

/**
 * The CRUD handlers shared by standalone and parent routes.
 * Ids are passed on as they arrive: the model parses them by the key's type, so a
 * non-numeric id for an Int key is a 400 invalid_id (Number() made it NaN, and lost
 * precision past 2^53 for BigInt keys).
 */
function crudHandlers(): string {
  return `    // Writes respond with the record; ?include= adds relations, as on reads
    const writeOptions = (request: FastifyRequest) => ({ include: (request.query as { include?: string }).include });

    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const results = await request.model!.getMany(request.parseListQuery());
        return reply.sendList(results.data, results.meta);
    });

    // Ids go to the model as strings — it parses them by the key's type (composite keys: "a~b")
    fastify.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const { include = '', fields = null } = request.query as Record<string, string>;
        return reply.send(await request.model!.get(id, include, {}, fields));
    });

    fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const payload = request.body as Record<string, unknown>;
        return reply.code(201).send(await request.model!.create(payload, writeOptions(request)));
    });

    fastify.patch('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const payload = request.body as Record<string, unknown>;
        return reply.send(await request.model!.update(id, payload, writeOptions(request)));
    });

    fastify.delete('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        await request.model!.delete(id);
        return reply.sendResponse(200, 'object_deleted_successfully', { modelName: request.model!.name });
    });`;
}

function sessionHook(className: string): string {
  return `    fastify.addHook('preHandler', async (request, reply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        request.model = new ${className}({ user: request.user, strictWrites: true });
    });`;
}

/**
 * Generate Fastify route for a standalone model (TypeScript)
 */
export function generateRouteFile(modelName: string, _modelInfo: ModelInfo, importPathPrefix = '../../../src'): string {
  const className = toClassName(modelName);
  return `import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { ${className} } from '${importPathPrefix}/models/${className}';

const ${modelName}Routes: FastifyPluginAsync = async (fastify) => {
${sessionHook(className)}

${crudHandlers()}
};

export default ${modelName}Routes;
`;
}

/**
 * Generate Fastify route for a parent model that has sub-routes (TypeScript)
 */
/** Marks a parent route that registers the sub-route files next to it by itself */
const SUB_ROUTE_DISCOVERY = 'every _<name> file next to this one';

export function generateParentRouteFile(modelName: string, _modelInfo: ModelInfo, _subRoutes: SubRouteInfo[]): string {
  const className = toClassName(modelName);
  const importPath = '../../../../src';

  return `import * as fs from 'fs';
import * as path from 'path';
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { ${className} } from '${importPath}/models/${className}';

const ${modelName}Routes: FastifyPluginAsync = async (fastify) => {
${sessionHook(className)}

    // Join-table sub-routes: ${SUB_ROUTE_DISCOVERY}, served under /:id/<name> — one
    // generated later for a new join table is picked up without editing this file
    const ext = path.extname(__filename);
    for (const file of fs.readdirSync(__dirname).sort()) {
        const match = /^_(\\w+)\\.(ts|js)$/.exec(file);
        if (!match || \`.\${match[2]}\` !== ext) continue;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const subRoute = require(path.join(__dirname, file));
        await fastify.register(subRoute.default ?? subRoute, { prefix: \`/:id/\${match[1]}\` });
    }

${crudHandlers()}
};

export default ${modelName}Routes;
`;
}

/**
 * Generate Fastify sub-route for a junction table (TypeScript).
 * Every handler is scoped to the parent id in the URL: the list through getMany's
 * server-side `where` (a client ?q= can only narrow it), single records through the
 * composite key { fkFieldToParent, otherFkField }.
 */
export function generateSubRouteFile(
  junctionModelName: string,
  _junctionModelInfo: ModelInfo,
  _parentModelInfo: ModelInfo,
  fkFieldToParent: string,
  otherFkField: string,
): string {
  const className = toClassName(junctionModelName);
  const importPath = '../../../../src';

  return `import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { ${className} } from '${importPath}/models/${className}';

const ${junctionModelName}Routes: FastifyPluginAsync = async (fastify) => {
${sessionHook(className)}

    // The parent from the URL, parsed by the key's type (400 invalid_id when it doesn't fit)
    const parentKey = (request: FastifyRequest) => ({
        ${fkFieldToParent}: request.model!.parseKey('${fkFieldToParent}', (request.params as { id: string }).id),
    });

    // Writes respond with the record; ?include= adds relations, as on reads
    const writeOptions = (request: FastifyRequest) => ({ include: (request.query as { include?: string }).include });

    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const results = await request.model!.getMany({ ...request.parseListQuery(), where: parentKey(request) });
        return reply.sendList(results.data, results.meta);
    });

    fastify.get('/:subId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { subId } = request.params as { subId: string };
        const { include = '', fields = null } = request.query as Record<string, string>;
        return reply.send(await request.model!.get({ ...parentKey(request), ${otherFkField}: subId }, include, {}, fields));
    });

    fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const payload = { ...(request.body as Record<string, unknown>), ...parentKey(request) };
        return reply.code(201).send(await request.model!.create(payload, writeOptions(request)));
    });

    fastify.patch('/:subId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { subId } = request.params as { subId: string };
        const payload = request.body as Record<string, unknown>;
        return reply.send(await request.model!.update({ ...parentKey(request), ${otherFkField}: subId }, payload, writeOptions(request)));
    });

    fastify.delete('/:subId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { subId } = request.params as { subId: string };
        await request.model!.delete({ ...parentKey(request), ${otherFkField}: subId });
        return reply.sendResponse(200, 'object_deleted_successfully', { modelName: request.model!.name });
    });
};

export default ${junctionModelName}Routes;
`;
}

// ─── Main generation orchestrator ───────────────────────────────────

/**
 * Generate all route files with junction-table-aware nested structure.
 * @param models      Models to generate routes for (may be filtered by --model)
 * @param routesDir   Output directory (e.g. routes/api/v1)
 * @param allModels   Full models map for junction detection (defaults to models)
 */
export function generateAllRoutes(
  models: Record<string, ModelInfo>,
  routesDir: string,
  allModels?: Record<string, ModelInfo>,
): void {
  if (!fs.existsSync(routesDir)) {
    fs.mkdirSync(routesDir, { recursive: true });
  }

  const { junctionModels, parentSubRoutes } = buildJunctionMap(allModels ?? models);

  for (const [modelName, modelInfo] of Object.entries(models)) {
    // Skip junction tables – they become sub-routes, not standalone files
    if (junctionModels.has(modelName)) {
      console.log(`Skipped route (junction table): ${modelName}`);
      continue;
    }

    const subRoutes = parentSubRoutes.get(modelName);

    if (subRoutes && subRoutes.length > 0) {
      // ── Parent model with sub-routes → directory structure ──
      const parentDir = path.join(routesDir, modelName);
      const indexPath = path.join(parentDir, 'index.ts');

      // A parent generated as a single file (before it had join tables) is the app's code:
      // the sub-routes go next to it, into the directory, and are registered by hand
      const flatPath = path.join(routesDir, `${modelName}.ts`);
      const flat = fs.existsSync(flatPath);

      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Generate parent index.ts
      if (flat) {
        console.log(`Skipped route (exists): ${modelName}.ts`);
      } else if (fs.existsSync(indexPath)) {
        console.log(`Skipped route (exists): ${modelName}/index.ts`);
      } else {
        const parentCode = generateParentRouteFile(modelName, modelInfo, subRoutes);
        fs.writeFileSync(indexPath, parentCode);
        console.log(`Generated route: ${modelName}/index.ts`);
      }

      // Generate each sub-route file
      for (const sr of subRoutes) {
        const subRoutePath = path.join(parentDir, `_${sr.subRouteName}.ts`);
        if (fs.existsSync(subRoutePath)) {
          console.log(`Skipped sub-route (exists): ${modelName}/_${sr.subRouteName}.ts`);
          continue;
        }
        const subRouteCode = generateSubRouteFile(
          sr.junctionModelName,
          sr.junctionModelInfo,
          modelInfo,
          sr.fkFieldToParent,
          sr.otherFkField,
        );
        fs.writeFileSync(subRoutePath, subRouteCode);
        console.log(`Generated sub-route: ${modelName}/_${sr.subRouteName}.ts`);
      }

      // A parent route that doesn't find its sub-routes itself must register each one
      const parentPath = flat ? flatPath : indexPath;
      const parentSource = fs.readFileSync(parentPath, 'utf-8');
      if (!parentSource.includes(SUB_ROUTE_DISCOVERY)) {
        for (const sr of subRoutes) {
          if (parentSource.includes(`_${sr.subRouteName}'`)) continue;
          const from = flat ? `./${modelName}/_${sr.subRouteName}` : `./_${sr.subRouteName}`;
          console.log(`Not served yet: register ${modelName}/_${sr.subRouteName}.ts in ${path.relative(routesDir, parentPath)} — `
            + `fastify.register(require('${from}').default, { prefix: '/:id/${sr.subRouteName}' });`);
        }
      }
    } else {
      // ── Standalone model → flat file (unchanged behaviour) ──
      const routePath = path.join(routesDir, `${modelName}.ts`);
      if (fs.existsSync(routePath)) {
        console.log(`Skipped route (exists): ${modelName}.ts`);
        continue;
      }
      const routeCode = generateRouteFile(modelName, modelInfo);
      fs.writeFileSync(routePath, routeCode);
      console.log(`Generated route: ${modelName}.ts`);
    }
  }
}
