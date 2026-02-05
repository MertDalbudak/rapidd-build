# @rapidd/build

Dynamic code generator that transforms Prisma schemas into complete **Fastify** CRUD APIs with intelligent PostgreSQL RLS-to-**TypeScript** translation.

## Features

- **Automatic CRUD API Generation** - Creates Fastify routes from Prisma models (TypeScript)
- **RLS Translation** - Converts PostgreSQL Row-Level Security policies to TypeScript/Prisma filters (ACL: Access Control Layer)
- **Dynamic & Schema-Aware** - Zero hardcoding, adapts to any database structure
- **Relationship Handling** - Supports 1:1, 1:n, n:m including junction tables
- **Role-Based Access Control** - Properly handles role checks in filters
- **Model Generation** - Creates TypeScript CRUD model classes with capitalized filenames
- **Selective Generation** - Update only specific models or components

## Requirements

- **Prisma 7+** (recommended) - Full support for Prisma 7's new architecture
- Node.js 18.0.0 or higher
- TypeScript 5.0+

## Installation

```bash
npm install @rapidd/build
```

## Quick Start

```bash
# Generate everything in current directory (default)
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

# Specify custom user table
npx rapidd build --user-table accounts

# Enable debug mode (generates acl-mappings.json)
npx rapidd build --debug
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <path>` | Output directory | `./` |
| `-s, --schema <path>` | Prisma schema file | `./prisma/schema.prisma` |
| `-m, --model <name>` | Generate/update only specific model | All models |
| `--only <component>` | Generate only: `model`, `route`, or `acl` | All components |
| `--user-table <name>` | User table name for ACL | Auto-detected |
| `--debug` | Enable debug mode | `false` |

## Generated Structure

```
./
├── src/
│   ├── models/
│   │   ├── User.ts
│   │   ├── Post.ts
│   │   ├── index.ts
│   │   └── ...
│   └── config/
│       └── acl.ts
└── routes/
    └── api/
        └── v1/
            ├── users.ts
            ├── posts.ts
            ├── index.ts
            └── ...
```

## Generated Code Examples

### Model (TypeScript)

```typescript
// src/models/Users.ts
import { Model } from '../orm/Model';
import { QueryBuilder, prisma } from '../orm/QueryBuilder';
import type { ModelOptions, GetManyResult } from '../types';

export class Users extends Model {
    constructor(options?: ModelOptions) {
        super('users', options);
    }

    async getMany(
        q: Record<string, unknown> = {},
        include: string | Record<string, unknown> = '',
        limit: number = 25,
        offset: number = 0,
        sortBy: string = 'id',
        sortOrder: 'asc' | 'desc' = 'asc'
    ): Promise<GetManyResult> {
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }

    async get(id: string | number, include?: string | Record<string, unknown>): Promise<Record<string, unknown>> {
        return await this._get(id, include);
    }

    async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await this._create(data);
    }

    async update(id: string | number, data: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await this._update(id, data);
    }

    async delete(id: string | number): Promise<Record<string, unknown>> {
        return await this._delete(id);
    }

    filter(include: string | Record<string, unknown>): Record<string, unknown> {
        return { ...this._filter(include), ...this.getAccessFilter() };
    }

    static override QueryBuilder = new QueryBuilder('users');
}
```

### Route (Fastify TypeScript)

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

    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const { q = {}, include = '', limit = '25', offset = '0', sortBy = 'id', sortOrder = 'asc' } = request.query as Record<string, string>;
        const model = (request as any).Users as Users;
        const results = await model.getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder as 'asc' | 'desc');
        return reply.sendList(results.data, results.meta);
    });

    // ... POST, PATCH, DELETE handlers
};

export default usersRoutes;
```

### ACL (TypeScript)

```typescript
// src/config/acl.ts
import type { AclConfig, RapiddUser } from '../types';

const acl: AclConfig = {
    model: {
        users: {
            canCreate(): boolean {
                return true;
            },
            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { id: user.id };
            },
            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { id: user.id };
            },
            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false;
            },
            getOmitFields(): string[] {
                return [];
            },
        },
        // ... other models
    },
};

export default acl;
```

## ACL Translation Example

**PostgreSQL Policy:**
```sql
CREATE POLICY user_policy ON posts
  FOR SELECT
  USING (author_id = current_user_id() OR current_user_role() IN ('admin', 'moderator'));
```

**Generated TypeScript:**
```typescript
getAccessFilter(user: RapiddUser) {
    if (['admin', 'moderator'].includes(user?.role)) return {};
    return { author_id: user?.id };
}
```

## Selective Generation

### Update Single Model

```bash
# Update only the account model across all components
npx rapidd build --model account
```

This will:
- Generate/update `src/models/Account.ts`
- Generate/update `routes/api/v1/account.ts`
- Update the `account` entry in `src/config/acl.ts`

### Update Single Component

```bash
# Regenerate all routes
npx rapidd build --only route

# Regenerate all ACL configs
npx rapidd build --only acl

# Regenerate all models
npx rapidd build --only model
```

### Combine Filters

```bash
# Update only the route for a specific model
npx rapidd build --model user --only route

# Update ACL for account model
npx rapidd build --model account --only acl
```

## Use Cases

### During Development
```bash
# After adding a new model to schema
npx rapidd build --model newModel

# After updating RLS policies
npx rapidd build --only acl
```

### Continuous Integration
```bash
# Full rebuild for CI/CD
npx rapidd build --output ./generated
```

### Incremental Updates
```bash
# Update specific model after schema changes
npx rapidd build --model user --only model
npx rapidd build --model user --only acl
```

## Migration from v1 (JavaScript/Express) to v2 (TypeScript/Fastify)

Version 2.0 brings major changes:

1. **TypeScript Output** - All generated files are now TypeScript (`.ts`)
2. **Fastify Framework** - Routes now use Fastify instead of Express
3. **New Directory Structure**:
   - Models: `src/models/` (was `src/Model/`)
   - ACL: `src/config/acl.ts` (was `rapidd/acl.js`)
   - Routes: `routes/api/v1/*.ts` (now TypeScript)
4. **Removed**: `rapidd/` folder and `relationships.json` are no longer generated

### Upgrade Steps

```bash
# 1. Update dependencies
npm install @rapidd/build@latest
npm install prisma@^7.0.0 @prisma/client@^7.0.0

# 2. Full rebuild
npx rapidd build

# 3. Update your imports in existing code
# Old: const { User } = require('./src/Model/User');
# New: import { User } from './src/models/User';
```

## Migration from Prisma 6 to 7

If you're upgrading from Prisma 6, this package now automatically:

1. **Uses `@prisma/internals`** for DMMF access (no longer relies on generated client)
2. **Reads database URL** from multiple sources in order:
   - `prisma.config.ts` (Prisma 7 default)
   - Schema file `datasource.url` (Prisma 5/6 style)
   - `DATABASE_URL` environment variable
3. **Maintains full compatibility** - no changes needed to your workflow

## API Usage

You can also use the package programmatically:

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
