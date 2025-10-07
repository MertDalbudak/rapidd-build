# @rapidd/build

Dynamic code generator that transforms Prisma schemas into complete Express.js CRUD APIs with intelligent PostgreSQL RLS-to-JavaScript translation.

## Features

- 🚀 **Automatic CRUD API Generation** - Creates Express.js routes from Prisma models
- 🔒 **RLS Translation** - Converts PostgreSQL Row-Level Security policies to JavaScript/Prisma filters
- 🎯 **Dynamic & Schema-Aware** - Zero hardcoding, adapts to any database structure
- 🔗 **Relationship Handling** - Supports 1:1, 1:n, n:m including junction tables
- 👥 **Role-Based Access Control** - Properly handles role checks in filters
- 📊 **Model Generation** - Creates CRUD model classes with capitalized filenames
- 🗺️ **Relationships JSON** - Generates complete relationship mappings with foreign keys
- ⚡ **Selective Generation** - Update only specific models or components

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
npx rapidd build --only rls
npx rapidd build --only relationship

# Combine model and component filters
npx rapidd build --model account --only route

# Specify custom user table
npx rapidd build --user-table accounts
```

## CLI Options

- `-o, --output <path>` - Output directory (default: `./`)
- `-s, --schema <path>` - Prisma schema file (default: `./prisma/schema.prisma`)
- `-m, --model <name>` - Generate/update only specific model (e.g., "account", "user")
- `--only <component>` - Generate only specific component: "model", "route", "rls", or "relationship"
- `--user-table <name>` - User table name for RLS (default: auto-detected)

## Selective Generation

### Update Single Model

```bash
# Update only the account model across all components
npx rapidd build --model account
```

This will:
- Generate/update `src/Model/Account.js`
- Generate/update `routes/api/v1/account.js`
- Update the `account` entry in `rapidd/relationships.json`
- Update the `account` entry in `rapidd/rls.js`

### Update Single Component

```bash
# Regenerate all routes
npx rapidd build --only route

# Regenerate all RLS configs
npx rapidd build --only rls

# Regenerate all models
npx rapidd build --only model

# Regenerate relationships
npx rapidd build --only relationship
```

### Combine Filters

```bash
# Update only the route for a specific model
npx rapidd build --model user --only route

# Update RLS for account model
npx rapidd build --model account --only rls
```

## Generated Structure

```
./
├── src/Model/
│   ├── User.js
│   ├── Post.js
│   └── ...
├── routes/
│   ├── user.js
│   ├── post.js
│   └── ...
└── rapidd/
    ├── rls.js
    ├── relationships.json
    └── rapidd.js
```

## RLS Translation Example

**PostgreSQL Policy:**
```sql
CREATE POLICY user_policy ON posts
  FOR SELECT
  USING (author_id = current_user_id() OR current_user_role() IN ('admin', 'moderator'));
```

**Generated JavaScript:**
```javascript
hasAccess: (data, user) => {
  return data?.author_id === user?.id || ['admin', 'moderator'].includes(user?.role);
},
getAccessFilter: (user) => {
  if (['admin', 'moderator'].includes(user?.role)) return {};
  return { author_id: user?.id };
}
```

## Usage with PostgreSQL RLS

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/mydb" npx rapidd build
```

## Use Cases

### During Development
```bash
# After adding a new model to schema
npx rapidd build --model newModel

# After changing relationships
npx rapidd build --only relationship

# After updating RLS policies
npx rapidd build --only rls
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
npx rapidd build --model user --only rls
```

## License

MIT
