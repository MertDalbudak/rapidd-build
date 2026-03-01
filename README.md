# @rapidd/build

Code generator that transforms Prisma schemas into Fastify CRUD APIs with TypeScript.

## Features

- **Automatic CRUD API Generation** - Creates Fastify routes from Prisma models (TypeScript)
- **Model Generation** - Creates TypeScript CRUD model classes
- **ACL Generation** - Generates default Access Control Layer config
- **Selective Generation** - Update only specific models or components

## Requirements

- **Prisma 7+**
- Node.js 18.0.0 or higher
- TypeScript 5.0+

## Installation

```bash
npm install @rapidd/build
```

## Quick Start

```bash
# Generate everything in current directory
npx rapidd build

# Generate in specific directory
npx rapidd build --output ./generated

# Generate only specific model
npx rapidd build --model user

# Generate only specific component
npx rapidd build --only model
npx rapidd build --only route
npx rapidd build --only acl

# Combine model and component filters
npx rapidd build --model account --only route
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <path>` | Output directory | `./` |
| `-s, --schema <path>` | Prisma schema file | `./prisma/schema.prisma` |
| `-m, --model <name>` | Generate/update only specific model | All models |
| `--only <component>` | Generate only: `model`, `route`, or `acl` | All components |

## Generated Structure

```
./
├── src/
│   ├── models/
│   │   ├── User.ts
│   │   ├── Post.ts
│   │   └── ...
│   └── config/
│       └── acl.ts
└── routes/
    └── api/
        └── v1/
            ├── users.ts
            ├── posts.ts
            └── ...
```

## Generated Code Examples

### Model

```typescript
// src/models/Users.ts
import { Model } from '../orm/Model';
import { QueryBuilder, prisma } from '../orm/QueryBuilder';
import type { ModelOptions, GetManyResult } from '../types';

export class Users extends Model {
    constructor(options?: ModelOptions) {
        super('users', options);
    }

    async getMany(...) { ... }
    async get(id, include?) { ... }
    async create(data) { ... }
    async update(id, data) { ... }
    async delete(id) { ... }

    static override QueryBuilder = new QueryBuilder('users');
}
```

### Route (Fastify)

```typescript
// routes/api/v1/users.ts
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Users, QueryBuilder } from '../../../src/models/Users';

const usersRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        (request as any).Users = new Users({ user: request.user });
    });

    fastify.get('/', async (request, reply) => { ... });
    fastify.get('/:id', async (request, reply) => { ... });
    fastify.post('/', async (request, reply) => { ... });
    fastify.patch('/:id', async (request, reply) => { ... });
    fastify.delete('/:id', async (request, reply) => { ... });
};

export default usersRoutes;
```

### ACL

```typescript
// src/config/acl.ts
import type { AclConfig, RapiddUser } from '../types';

const acl: AclConfig = {
    model: {
        users: {
            canCreate(_user: RapiddUser): boolean {
                return true;
            },
            getAccessFilter(_user: RapiddUser): Record<string, unknown> | boolean {
                return {};
            },
            getUpdateFilter(_user: RapiddUser): Record<string, unknown> | boolean | false {
                return {};
            },
            getDeleteFilter(_user: RapiddUser): Record<string, unknown> | boolean | false {
                return {};
            },
            getOmitFields(_user: RapiddUser): string[] {
                return [];
            },
        },
        // ... other models
    },
};

export default acl;
```

## Selective Generation

### Update Single Model

```bash
npx rapidd build --model account
```

### Update Single Component

```bash
npx rapidd build --only route
npx rapidd build --only acl
npx rapidd build --only model
```

### Combine Filters

```bash
npx rapidd build --model user --only route
npx rapidd build --model account --only acl
```

## API Usage

```typescript
import { buildModels, parsePrismaSchema, generateAllModels } from '@rapidd/build';

// Full build
await buildModels({
  schema: './prisma/schema.prisma',
  output: './generated'
});

// Parse schema only
const { models, enums } = parsePrismaSchema('./prisma/schema.prisma');

// Generate models only
generateAllModels(models, './src/models');
```

## License

MIT
