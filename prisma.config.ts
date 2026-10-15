import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';
import { assertPrismaRehearsalUrl } from './src/lib/prismaRehearsal';
import { buildRuntimeDatabaseUrl } from './src/lib/databaseUrl';

// Match service/script precedence while letting an explicitly supplied rehearsal
// URL override every local file. Generation/builds never need a live database.
const inheritedEnvironment = { ...process.env };
for (const path of ['.env', '.env.production', '.env.local', '.env.production.local']) {
  if (existsSync(path)) dotenv.config({ path, override: true, quiet: true });
}
Object.assign(process.env, inheritedEnvironment);
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://build:build@127.0.0.1:1/build';
if (process.env.PRISMA7_REHEARSAL === '1') {
  assertPrismaRehearsalUrl(databaseUrl, process.env.DATABASE_RUNTIME_HOST);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: buildRuntimeDatabaseUrl(databaseUrl, process.env.DATABASE_RUNTIME_HOST),
  },
});
