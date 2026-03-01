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

/**
 * Generate Fastify route for a single model (TypeScript)
 */
export function generateRouteFile(modelName: string): string {
  const className = toClassName(modelName);

  return `import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { ${className}, QueryBuilder } from '../../../src/models/${className}';

const ${modelName}Routes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        (request as any).${className} = new ${className}({ user: request.user });
    });

    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { q = {}, include = '', limit = '25', offset = '0', sortBy = 'id', sortOrder = 'asc' } = request.query as Record<string, string>;
            const model = (request as any).${className} as ${className};
            const results = await model.getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder as 'asc' | 'desc');
            return reply.sendList(results.data, results.meta);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id } = request.params as { id: string };
            const { include = '' } = request.query as { include?: string };
            const model = (request as any).${className} as ${className};
            const response = await model.get(id, include);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.create(payload);
            return reply.code(201).send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.patch('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).${className} as ${className};
            const response = await model.update(id, payload);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });

    fastify.delete('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id } = request.params as { id: string };
            const model = (request as any).${className} as ${className};
            await model.delete(id);
            return reply.sendResponse(200, 'object_deleted_successfully', { modelName: '${className}' });
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });
};

export default ${modelName}Routes;
`;
}

/**
 * Generate all route files
 */
export function generateAllRoutes(models: Record<string, ModelInfo>, routesDir: string): void {
  // Create routes directory if it doesn't exist
  if (!fs.existsSync(routesDir)) {
    fs.mkdirSync(routesDir, { recursive: true });
  }

  // Generate individual route files (skip existing)
  for (const modelName of Object.keys(models)) {
    const routePath = path.join(routesDir, `${modelName}.ts`);
    if (fs.existsSync(routePath)) {
      console.log(`Skipped route (exists): ${modelName}.ts`);
      continue;
    }
    const routeCode = generateRouteFile(modelName);
    fs.writeFileSync(routePath, routeCode);
    console.log(`Generated route: ${modelName}.ts`);
  }
}
