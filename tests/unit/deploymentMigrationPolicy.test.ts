import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const checker = path.resolve('scripts/deployment/check-expand-only.mjs');

function withMigration(sql: string, run: (directory: string) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'migration-policy-'));
  const directory = path.join(root, '20260808210000_test');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'migration.sql'), sql);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('expand-only policy accepts a trigger function with internal semicolons', () => {
  withMigration(`
    CREATE TABLE "StatsTrackingEpoch" ("id" TEXT PRIMARY KEY);
    INSERT INTO "StatsTrackingEpoch" ("id") VALUES ('test');
    CREATE FUNCTION record_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER record_test_trigger AFTER UPDATE ON "Job"
    FOR EACH ROW EXECUTE FUNCTION record_test();
  `, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });
});

test('expand-only policy still rejects ordinary data mutation', () => {
  withMigration('INSERT INTO "Job" ("id") VALUES (\'unsafe\');', (directory) => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Disallowed statements/);
  });
});

test('expand-only policy permits only the exact terminal native-key reconciliation', () => {
  const exact = `
    UPDATE "NativeScoringRequest"
    SET "activeKey" = NULL
    WHERE status = 'failed' AND "activeKey" IS NOT NULL;
  `;
  withMigration(exact, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });

  withMigration(exact.replace("status = 'failed'", "status = 'queued'"), (directory) => {
    const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Disallowed statements/);
  });
});

test('expand-only policy allows an expression index to collect its own statistics', () => {
  withMigration(`
    CREATE INDEX IF NOT EXISTS "Job_canonicalUrl_lower_idx" ON "Job" (lower("canonicalUrl"));
    ANALYZE "Job";
  `, (directory) => {
    const output = execFileSync(process.execPath, [checker, directory], { encoding: 'utf8' });
    assert.match(output, /Expand-only migration policy passed/);
  });
});

test('expand-only policy does not let other maintenance in through ANALYZE', () => {
  for (const sql of ['ANALYZE;', 'VACUUM "Job";', 'VACUUM FULL "Job";', 'ANALYZE "Job" ("title");']) {
    withMigration(sql, (directory) => {
      const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, sql);
      assert.match(result.stderr, /Disallowed statements/, sql);
    });
  }
});
