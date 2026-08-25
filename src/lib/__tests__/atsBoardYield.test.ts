import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_LOW_YIELD_CADENCE_DAYS,
  ATS_YIELD_MIN_EVIDENCE,
  boardSlugFromJobUrl,
  classifyBoardYield,
  lowYieldNextCheckDate,
} from '../atsBoardYield';
import { ATS_BATCH_WALL_CLOCK_MS, ATS_BOARD_CONCURRENCY } from '../ingestionTaskCatalog';

test('a board slug is recovered from a real job URL on every platform', () => {
  const cases: Array<[string, string, string]> = [
    ['https://job-boards.greenhouse.io/hyphenconnect/jobs/5074579007', 'greenhouse', 'hyphenconnect'],
    ['https://boards.greenhouse.io/andurilindustries/jobs/12345', 'greenhouse', 'andurilindustries'],
    ['https://jobs.lever.co/spear/e7bf85c7-642f', 'lever', 'spear'],
    ['https://jobs.ashbyhq.com/bjakcareer/abc-123', 'ashby', 'bjakcareer'],
    ['https://american-transport-team.breezy.hr/p/d2e6ece4f91b-c', 'breezy', 'american-transport-team'],
    ['https://apply.workable.com/acme/j/ABC123/', 'workable', 'acme'],
    ['https://jobs.smartrecruiters.com/AcmeCorp/744000', 'smartrecruiters', 'AcmeCorp'],
    ['https://acme.bamboohr.com/careers/42', 'bamboohr', 'acme'],
    // The stored slug keeps the infrastructure shard, matching AtsCompany.
    ['https://icf.wd5.myworkdayjobs.com/en-US/icfexternal_careers/job/Alexandria-VA/Analyst_R123', 'workday', 'icf.wd5::icfexternal_careers'],
  ];
  for (const [url, platform, expected] of cases) {
    assert.equal(boardSlugFromJobUrl(url, platform), expected, url);
  }
});

test('an unusable URL yields no slug rather than a wrong one', () => {
  // A wrong slug would attribute another board's jobs to this one and could
  // demote a working board.
  for (const url of ['', '   ', 'not a url', 'mailto:a@b.c']) {
    assert.equal(boardSlugFromJobUrl(url, 'greenhouse'), null, JSON.stringify(url));
  }
  assert.equal(boardSlugFromJobUrl('https://example.com/x', 'indeed'), null);
  assert.equal(boardSlugFromJobUrl(null, 'lever'), null);
});

test('one surviving job protects a board regardless of volume', () => {
  const verdict = classifyBoardYield({ storedJobs: 5_000, survivingJobs: 1 });
  assert.equal(verdict.classification, 'productive');
  assert.match(verdict.reason, /1 job\(s\) from this board survived/);
});

test('a board is never demoted on thin evidence', () => {
  const verdict = classifyBoardYield({ storedJobs: ATS_YIELD_MIN_EVIDENCE - 1, survivingJobs: 0 });
  assert.equal(verdict.classification, 'insufficient_evidence');
  // A quiet board with a handful of postings must not be mistaken for spam.
  assert.equal(classifyBoardYield({ storedJobs: 0, survivingJobs: 0 }).classification, 'insufficient_evidence');
  assert.equal(classifyBoardYield({ storedJobs: 11, survivingJobs: 0 }).classification, 'insufficient_evidence');
});

test('a large sample with zero survivors is demoted', () => {
  // Anduril's real shape at the August 25 measurement.
  const verdict = classifyBoardYield({ storedJobs: 2_327, survivingJobs: 0 });
  assert.equal(verdict.classification, 'low_yield');
  assert.match(verdict.reason, /2327 stored job\(s\) and none survived/);
});

test('demotion is a longer cadence, not a removal', () => {
  const now = new Date('2026-08-25T12:00:00.000Z');
  assert.equal(
    lowYieldNextCheckDate(now).valueOf() - now.valueOf(),
    ATS_LOW_YIELD_CADENCE_DAYS * 86_400_000,
  );
  const script = readFileSync(
    path.join(process.cwd(), 'scripts/demote_low_yield_ats_boards.ts'),
    'utf8',
  );
  // Only the next sweep date moves. Status, rotation day, and history stay.
  assert.match(script, /data: \{ nextCheckDate: lowYieldNextCheckDate\(\) \}/);
  assert.doesNotMatch(script, /status: '(parked|blacklisted)'/);
  assert.doesNotMatch(script, /atsCompany\.delete/);
  assert.match(script, /const \{ apply, approved \} = parseMode\(argv\)/);
});

test('turn capacity was raised on both axes', () => {
  // Nineteen boards per turn against a 500-board budget meant the wall clock,
  // not the budget, was the limit.
  assert.ok(ATS_BOARD_CONCURRENCY >= 20, `concurrency was ${ATS_BOARD_CONCURRENCY}`);
  assert.ok(ATS_BATCH_WALL_CLOCK_MS >= 1_800_000, `wall clock was ${ATS_BATCH_WALL_CLOCK_MS}`);
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  assert.match(ingestion, /const atsConcurrency = ATS_BOARD_CONCURRENCY;/);
});
