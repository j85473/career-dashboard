import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { interviewedJobCountSql } from '../statsInterviewedJobs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

test('interviewed jobs includes past interviews and counts each job once', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE "Job" (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE "JobStatusHistory" ("jobId" TEXT, status TEXT);
      INSERT INTO "Job" VALUES
        ('past-applied', 'applied'), ('past-passed', 'passed'),
        ('past-archived', 'archived'), ('current', 'interviewing'),
        ('never-interviewed', 'applied');
      INSERT INTO "JobStatusHistory" VALUES
        ('past-applied', 'interviewing'), ('past-applied', 'applied'),
        ('past-applied', 'interviewing'), ('past-passed', 'interviewing'),
        ('past-archived', 'interviewing'), ('never-interviewed', 'applied');
    `);
    const count = () => Object.values(database.prepare(interviewedJobCountSql.sql).get()!)[0];
    assert.equal(count(), 4, 'past interviews survive later statuses; a legacy current interview counts');
    database.exec(`INSERT INTO "JobStatusHistory" VALUES ('current', 'interviewing');`);
    assert.equal(count(), 4, 'current status and history do not double-count a job');
    database.exec(`UPDATE "Job" SET status = 'archived' WHERE id = 'current';`);
    assert.equal(count(), 4, 'archiving an interviewed job does not lower the total');
    database.exec(`DELETE FROM "JobStatusHistory"; UPDATE "Job" SET status = 'applied';`);
    assert.equal(count(), 0, 'no interviews is zero, not all applications');
  } finally {
    database.close();
  }
});
