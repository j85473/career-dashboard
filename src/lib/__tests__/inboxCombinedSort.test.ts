import assert from 'node:assert/strict';
import test from 'node:test';

import {
  combinedInboxAtsPriority,
  orderCombinedInboxCandidates,
  type CombinedInboxCandidate,
} from '../inboxEnteredAt';

function candidate(
  id: string,
  enteredInboxAt: string,
  source: string,
  aimFitScore: number | null,
): CombinedInboxCandidate {
  return {
    id,
    enteredInboxAt: new Date(enteredInboxAt),
    source,
    manualAts: null,
    url: null,
    aimFitScore,
  };
}

test('Combined Sort recognizes the requested ATS priority and groups every other system last', () => {
  assert.equal(combinedInboxAtsPriority(candidate('a', '2026-09-04T12:00:00Z', 'ATS-greenhouse', 50)), 1);
  assert.equal(combinedInboxAtsPriority(candidate('b', '2026-09-04T12:00:00Z', 'ATS-ashby', 50)), 2);
  assert.equal(combinedInboxAtsPriority(candidate('c', '2026-09-04T12:00:00Z', 'ATS-lever', 50)), 3);
  assert.equal(combinedInboxAtsPriority(candidate('d', '2026-09-04T12:00:00Z', 'ATS-rippling', 50)), 4);
  assert.equal(combinedInboxAtsPriority(candidate('e', '2026-09-04T12:00:00Z', 'ATS-workday', 50)), 5);
  assert.equal(combinedInboxAtsPriority(candidate('f', '2026-09-04T12:00:00Z', 'ATS-breezy', 50)), 6);
  assert.equal(combinedInboxAtsPriority(candidate('g', '2026-09-04T12:00:00Z', 'Himalayas', 50)), 6);
});

test('Combined Sort uses Inbox entry time, ATS priority, Aim Fit, and stable ID in that order', () => {
  const sameEntryTime = '2026-09-04T12:00:00.000Z';
  const ordered = orderCombinedInboxCandidates([
    candidate('remaining-high', sameEntryTime, 'ATS-breezy', 99),
    candidate('greenhouse-low', sameEntryTime, 'ATS-greenhouse', 60),
    candidate('ashby-high', sameEntryTime, 'ATS-ashby', 95),
    candidate('greenhouse-high-b', sameEntryTime, 'ATS-greenhouse', 85),
    candidate('greenhouse-high-a', sameEntryTime, 'ATS-greenhouse', 85),
    candidate('newest-workday', '2026-09-04T12:00:01.000Z', 'ATS-workday', 10),
  ]);

  assert.deepEqual(ordered.map((row) => row.id), [
    'newest-workday',
    'greenhouse-high-a',
    'greenhouse-high-b',
    'greenhouse-low',
    'ashby-high',
    'remaining-high',
  ]);
});

test('a manual ATS correction overrides source and URL inference', () => {
  const corrected = {
    ...candidate('corrected', '2026-09-04T12:00:00Z', 'ATS-workday', 80),
    manualAts: 'Lever',
  };
  assert.equal(combinedInboxAtsPriority(corrected), 3);
});
