import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outputPath = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;

if (!outputPath || !path.isAbsolute(outputPath)) {
  console.error('A safe absolute backup output path is required.');
  process.exit(2);
}
if (!databaseUrl) {
  console.error('DATABASE_URL is required to create a PostgreSQL backup.');
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  console.error('DATABASE_URL is not a valid URL.');
  process.exit(2);
}

if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
  console.error('DATABASE_URL must use the postgres or postgresql protocol.');
  process.exit(2);
}

const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
const databaseUser = decodeURIComponent(parsed.username);
if (!parsed.hostname || !databaseName || !databaseUser) {
  console.error('DATABASE_URL must include a hostname, username, and database name.');
  process.exit(2);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const childEnvironment = { ...process.env };
if (parsed.password) childEnvironment.PGPASSWORD = decodeURIComponent(parsed.password);
const sslMode = parsed.searchParams.get('sslmode');
if (sslMode) childEnvironment.PGSSLMODE = sslMode;

const args = [
  '--format=custom',
  '--no-owner',
  '--no-privileges',
  '--file', outputPath,
  '--host', parsed.hostname,
  '--port', parsed.port || '5432',
  '--username', databaseUser,
  '--dbname', databaseName,
];

const result = spawnSync('pg_dump', args, {
  env: childEnvironment,
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (result.error) {
  console.error(`Unable to run pg_dump: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`pg_dump failed with exit code ${result.status}.`);
  process.exit(result.status ?? 1);
}

const size = fs.statSync(outputPath).size;
if (size === 0) {
  console.error('pg_dump produced an empty backup file.');
  process.exit(1);
}

fs.chmodSync(outputPath, 0o600);

console.log(`PostgreSQL backup created: ${outputPath} (${size} bytes)`);
