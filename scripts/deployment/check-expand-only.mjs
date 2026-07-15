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
  /^ALTER\s+TABLE\s+.+\s+ADD\s+(?:COLUMN|CONSTRAINT)\s+/is,
];

const violations = [];
for (const filename of migrationFiles) {
  const sql = fs.readFileSync(filename, 'utf8')
    .replace(/--[^\n]*/g, '')
    .trim();

  for (const rawStatement of sql.split(';')) {
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
