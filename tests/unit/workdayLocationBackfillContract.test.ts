import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('scripts/backfill_workday_locations.ts', 'utf8');

test('Workday location backfill is dry-run by default and uses authoritative details', () => {
  assert.match(source, /const \{ apply \} = parseArguments/);
  assert.match(source, /const detail = await scrapeAtsApi\(candidate\.url\)/);
  assert.match(source, /detail\.ats !== 'Workday'/);
  assert.match(source, /if \(!apply\)/);
});

test('Workday location backfill cannot change a row that became scored during detail fetching', () => {
  const guardedWrite = source.slice(source.indexOf('const result = await prisma.job.updateMany'));
  assert.match(guardedWrite, /location: candidate\.location/);
  assert.match(guardedWrite, /aimFitScore: null/);
  assert.match(guardedWrite, /reqFitScore: null/);
  assert.doesNotMatch(guardedWrite, /aimFitScore:\s*\{/);
  assert.doesNotMatch(guardedWrite, /reqFitScore:\s*\{/);
});
