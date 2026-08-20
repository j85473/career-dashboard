import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('scripts/repair_workday_company_names.ts', 'utf8');

test('Workday company repair is dry-run by default and requires authoritative detail data', () => {
  assert.match(source, /const args = parseArguments/);
  assert.match(source, /const detail = await scrapeWorkdayPostingDetail\(candidate\.url\)/);
  assert.match(source, /detail\.ats !== 'Workday'/);
  assert.match(source, /if \(!detail\.company\)/);
  assert.match(source, /if \(!args\.apply\)/);
  assert.doesNotMatch(source, /workdayBoardCompanyFallback/);
});

test('Workday company repair cannot change scored, authoritative, leased, or concurrently changed rows', () => {
  const guardedWrite = source.slice(source.indexOf('const result = await prisma.job.updateMany'));
  assert.match(guardedWrite, /company: repair\.candidate\.company/);
  assert.match(guardedWrite, /updatedAt: repair\.candidate\.updatedAt/);
  assert.match(guardedWrite, /aimFitScore: null/);
  assert.match(guardedWrite, /reqFitScore: null/);
  assert.match(guardedWrite, /batchJobId: null/);
  assert.match(guardedWrite, /afBatchId: null/);
  assert.match(guardedWrite, /jdBatchId: null/);
  assert.match(guardedWrite, /tailoringStaged: false/);
  assert.match(guardedWrite, /scoringStatus: \{ not: 'scoring' \}/);
  assert.match(guardedWrite, /scoringBatchItems: \{ none: \{ status: 'leased' \} \}/);
  assert.match(guardedWrite, /scoreEvents:/);
  assert.match(guardedWrite, /evaluationType: \{ in: \[\.\.\.AUTHORITATIVE_SCORE_EVENT_TYPES\] \}/);
  assert.match(guardedWrite, /staleAt: null/);
});

test('explicit scored-row repair requires a live resolved allowlist and queues a fresh score atomically', () => {
  assert.match(source, /--rescore-id/);
  assert.match(source, /Requested rescore job\(s\) were not safely resolved from live Workday detail/);
  assert.match(source, /SELECT id FROM "Job" WHERE id = \$\{repair\.candidate\.id\} FOR UPDATE/);
  assert.match(source, /current\.updatedAt\.valueOf\(\) !== repair\.candidate\.updatedAt\.valueOf\(\)/);
  assert.match(source, /status: 'pending_af'/);
  assert.match(source, /scoringStatus: 'queued'/);
  assert.match(source, /experienceStatus: 'queued'/);
  assert.match(source, /invalidateActiveJobScores\(\{/);
  assert.match(source, /changedFields: \['company'\]/);
  assert.match(source, /eventType: 'user_rescore'/);
  assert.match(source, /route: 'workday_company_repair'/);
});
