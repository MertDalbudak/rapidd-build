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

## Installation

```bash
npm install @rapidd/build
```

## Quick Start

```bash
# Generate in current directory (default)
npx rapidd build

# Generate in specific directory
npx rapidd build --output ./generated

# Specify custom user table
npx rapidd build --user-table accounts
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

## CLI Options

- `-o, --output <path>` - Output directory (default: `./`)
- `-s, --schema <path>` - Prisma schema file (default: `./prisma/schema.prisma`)
- `-u, --user-table <name>` - User table name for RLS (default: auto-detected)

## Usage with PostgreSQL RLS

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/mydb" npx rapidd build
```

## License

MIT
