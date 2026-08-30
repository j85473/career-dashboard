import fs from 'node:fs';
import path from 'node:path';

const migrationsDirectory = path.resolve(process.argv[2] || 'prisma/migrations');
if (!fs.existsSync(migrationsDirectory)) {
  console.error(`Migration directory does not exist: ${migrationsDirectory}`);
  process.exit(1);
}

const migrationFiles = fs.readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(migrationsDirectory, entry.name, 'migration.sql'))
  .filter((filename) => fs.existsSync(filename))
  .sort();

if (migrationFiles.length === 0) {
  console.error('No migration.sql files were found.');
  process.exit(1);
}

const allowedStatements = [
  /^BEGIN$/i,
  /^COMMIT$/i,
  /^CREATE\s+TABLE\s+/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+/i,
  /^CREATE\s+EXTENSION\s+/i,
  /^CREATE\s+FUNCTION\s+/i,
  // The ATS Phase 2 release narrows the already-deployed compatibility guard:
  // an authorized v2 transaction may update lifecycle summaries, while even
  // that transaction remains unable to change legacy JSON/cursor authority.
  /^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"guard_legacy_ats_batch_write"\s*\(\s*\)/i,
  /^CREATE\s+TRIGGER\s+/i,
  /^ALTER\s+TABLE\s+.+\s+ADD\s+(?:COLUMN|CONSTRAINT)\s+/is,
  // Refreshing planner statistics touches pg_statistic only: it cannot read,
  // alter, or remove a single application row, which is why it belongs in an
  // expand-only release. A migration that adds an expression index needs it in
  // the same file, because until the statistics exist the planner misjudges
  // that index badly enough to choose a plan worse than the one the index was
  // added to replace. Bare single-table form only, so no VACUUM-style or
  // whole-database maintenance can enter a migration through this door.
  /^ANALYZE\s+"[A-Za-z_][A-Za-z0-9_]*"$/i,
  // A migration-owned epoch row is append-only metadata. Keep this exception
  // narrow so ordinary data mutation remains forbidden during deployments.
  /^INSERT\s+INTO\s+"StatsTrackingEpoch"\s+/i,
  // The ATS compatibility release requires exactly one dormant, append-only
  // runtime-gate row. Pin every column and value so this exception cannot
  // authorize application-data inserts or premature v2 activation.
  /^INSERT\s+INTO\s+"AtsAcquisitionRuntimeGate"\s*\(\s*"id"\s*,\s*"minimumWriterVersion"\s*,\s*"compatibilityWriterVersion"\s*,\s*"updatedAt"\s*\)\s*VALUES\s*\(\s*'global'\s*,\s*1\s*,\s*2\s*,\s*CURRENT_TIMESTAMP\s*\)\s*ON\s+CONFLICT\s*\(\s*"id"\s*\)\s+DO\s+NOTHING$/i,
  // The manual-scoring cutover clears only stale exclusivity keys on rows that
  // were already terminally failed. The migration is already applied to the
  // production database; this exact exception lets immutable release checks
  // accept its recorded SQL without permitting any other UPDATE statement.
  /^UPDATE\s+"NativeScoringRequest"\s+SET\s+"activeKey"\s*=\s*NULL\s+WHERE\s+status\s*=\s*'failed'\s+AND\s+"activeKey"\s+IS\s+NOT\s+NULL$/i,
];

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let singleQuoted = false;
  let doubleQuoted = false;
  let dollarTag = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += char;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === '$') {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }

    if (!doubleQuoted && char === "'") {
      current += char;
      if (singleQuoted && next === "'") {
        current += next;
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }

    if (!singleQuoted && char === '"') {
      current += char;
      if (doubleQuoted && next === '"') {
        current += next;
        index += 1;
      } else {
        doubleQuoted = !doubleQuoted;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

const violations = [];
for (const filename of migrationFiles) {
  const sql = fs.readFileSync(filename, 'utf8')
    .replace(/--[^\n]*/g, '')
    .trim();

  for (const rawStatement of splitSqlStatements(sql)) {
    const statement = rawStatement.replace(/\s+/g, ' ').trim();
    if (!statement) continue;
    if (!allowedStatements.some((pattern) => pattern.test(statement))) {
      violations.push(`${path.relative(process.cwd(), filename)}: ${statement.slice(0, 180)}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Deployment blocked: migrations must be expand-only. Disallowed statements:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Expand-only migration policy passed for ${migrationFiles.length} migration(s).`);
