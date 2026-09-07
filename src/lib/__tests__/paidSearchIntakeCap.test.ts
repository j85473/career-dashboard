import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PAID_SEARCH_DAILY_RUN_CAPS,
  paidSearchRunRateDecision,
  RUN_STATUSES_THAT_SPENT_BUDGET,
  utcDayStart,
} from '../paidSearchRunRate';
import {
  ATS_PLACEHOLDER_BODY_CHARACTERS,
  ATS_PLACEHOLDER_REQUISITION_REASON,
  buildAtsPlaceholderDiscardUpdate,
  isAtsPlaceholderRequisition,
} from '../jdRecoveryPolicy';

function fakeRuns(count: number) {
  const seen: unknown[] = [];
  return {
    seen,
    client: {
      ingestionSourceRun: {
        count: async (args: unknown) => { seen.push(args); return count; },
      },
    } as never,
  };
}

test('Glassdoor searches stop at their daily run cap', async () => {
  // 2026-09-07: the discovery expansion took Glassdoor from 3-4 runs a day to
  // 37. Total demand — 20 searches, 48 ingest-time description calls and 74
  // recovery-pass calls — exceeded the whole 103/day ceiling, so no hourly
  // reserve could have covered it. Only intake or the quota can.
  const now = new Date('2026-09-07T15:23:00Z');
  const cap = PAID_SEARCH_DAILY_RUN_CAPS['Glassdoor (RapidAPI)'];
  assert.equal(cap, 4);

  const under = await paidSearchRunRateDecision('Glassdoor (RapidAPI)', fakeRuns(3).client, now);
  assert.deepEqual(under, { allowed: true, cap: 4, runsToday: 3 });
  const at = await paidSearchRunRateDecision('Glassdoor (RapidAPI)', fakeRuns(4).client, now);
  assert.equal(at.allowed, false);
  const over = await paidSearchRunRateDecision('Glassdoor (RapidAPI)', fakeRuns(37).client, now);
  assert.equal(over.allowed, false);
});

test('only runs that reached the provider count against the cap', async () => {
  // A run refused by the budget or an open circuit spent nothing. Counting it
  // would let a quiet day of refusals lock the source out of the next one.
  const now = new Date('2026-09-07T15:23:00Z');
  const { seen, client } = fakeRuns(0);
  await paidSearchRunRateDecision('Glassdoor (RapidAPI)', client, now);
  const where = (seen[0] as { where: Record<string, unknown> }).where;
  assert.deepEqual(where.status, { in: [...RUN_STATUSES_THAT_SPENT_BUDGET] });
  assert.deepEqual(RUN_STATUSES_THAT_SPENT_BUDGET, ['success', 'partial']);
  assert.deepEqual(where.startedAt, { gte: utcDayStart(now) });
  assert.equal(utcDayStart(now).toISOString(), '2026-09-07T00:00:00.000Z');
});

test('a source with no cap is never gated, and never queries for one', async () => {
  const { seen, client } = fakeRuns(999);
  const decision = await paidSearchRunRateDecision('Indeed', client, new Date());
  assert.deepEqual(decision, { allowed: true, cap: null, runsToday: 0 });
  assert.equal(seen.length, 0, 'an uncapped source must not pay for a count query');
});

test('the Glassdoor search is actually gated on the cap', () => {
  const ingestion = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'jobIngestion.ts'), 'utf8',
  );
  const decisionIndex = ingestion.indexOf('paidSearchRunRateDecision(GLASSDOOR_SOURCE');
  assert.ok(decisionIndex >= 0, 'Glassdoor must consult the run-rate policy');
  assert.match(ingestion, /glassdoorRunRate\?\.allowed &&/);
});

test('a direct ATS board that published a token body is not sent for manual review', () => {
  // Breezy's evergreen requisitions: HTTP 200, real markup, body literally
  // "n/a". Titles like "Midwest Wild Card" and "Refresh" are not roles. They
  // reached Action Needed asking Joseph to review a posting that does not
  // exist, and classified as recoverable, so the clearing script would requeue
  // them into a series that can never succeed.
  assert.equal(isAtsPlaceholderRequisition({ source: 'ATS-breezy', fetchedBody: 'n/a' }), true);
  assert.equal(isAtsPlaceholderRequisition({ source: 'ATS-breezy', fetchedBody: '  n/a  ' }), true);
  assert.equal(
    isAtsPlaceholderRequisition({ source: 'ATS-breezy', fetchedBody: 'x'.repeat(ATS_PLACEHOLDER_BODY_CHARACTERS) }),
    false,
    'a real if short posting keeps its bounded recovery series',
  );

  // Nothing came back is not the same as the board publishing nothing — a
  // transport failure looks identical, and the ATS detail calls exist to fill
  // those in.
  assert.equal(isAtsPlaceholderRequisition({ source: 'ATS-breezy', fetchedBody: '' }), false);
  assert.equal(isAtsPlaceholderRequisition({ source: 'ATS-breezy', fetchedBody: null }), false);

  // Confined to direct boards. An aggregator's short body means the aggregator
  // did not publish the whole thing — the opposite situation.
  for (const source of ['Glassdoor (RapidAPI)', 'Indeed', 'Adzuna', 'Manual Import', null]) {
    assert.equal(isAtsPlaceholderRequisition({ source, fetchedBody: 'n/a' }), false, String(source));
  }

  const update = buildAtsPlaceholderDiscardUpdate('JD recovery rejected: no usable role duties.');
  assert.equal(update.status, 'dismissed');
  assert.equal(update.passReason, ATS_PLACEHOLDER_REQUISITION_REASON);
});

test('the placeholder rule reads the freshly fetched body, not the stored one', () => {
  // 35 of the 36 Breezy rows in Action Needed hold an empty description while
  // their pages return a token body: a rejected body is never stored. Judging
  // the stored value would miss every one of them.
  const route = readFileSync(
    path.join(process.cwd(), 'src', 'app', 'api', 'jobs', 'batch-jd-submit', 'route.ts'), 'utf8',
  );
  assert.match(route, /isAtsPlaceholderRequisition\(\{ source: job\.source, fetchedBody: markdown \}\)/);

  // And only on a terminal outcome — a first short answer still gets its
  // remaining bounded attempts.
  const terminalIndex = route.indexOf('recoveryDecision.terminal');
  const placeholderIndex = route.indexOf('isAtsPlaceholderRequisition', terminalIndex);
  assert.ok(placeholderIndex > terminalIndex, 'the discard must sit inside the terminal branch');
});
