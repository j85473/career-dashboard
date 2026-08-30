import { spawnSync } from 'node:child_process';
import path from 'node:path';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error('DATABASE_URL is required for the read-only ATS ledger verifier.');
  process.exit(2);
}

const parsed = new URL(sourceUrl);
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
  console.error('The ATS ledger verifier requires a PostgreSQL DATABASE_URL.');
  process.exit(2);
}
const schema = parsed.searchParams.get('schema') || 'public';
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
  console.error('DATABASE_URL contains an unsafe PostgreSQL schema name.');
  process.exit(2);
}

const sslMode = parsed.searchParams.get('sslmode');
const environment = {
  ...process.env,
  PGHOST: parsed.hostname,
  PGPORT: parsed.port || '5432',
  PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  PGUSER: decodeURIComponent(parsed.username),
  PGPASSWORD: decodeURIComponent(parsed.password),
  PGOPTIONS: `-c search_path=${schema}`,
  ...(sslMode ? { PGSSLMODE: sslMode } : {}),
};

const sqlPath = path.join(
  process.cwd(),
  'scripts/sql/verify_ats_acquisition_ledger_phase1.sql',
);
const result = spawnSync('psql', [
  '-X',
  '-v', 'ON_ERROR_STOP=1',
  '-P', 'pager=off',
  '-f', sqlPath,
], {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to run the ATS ledger verifier: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 2);
