import assert from 'node:assert/strict';
import test from 'node:test';

import {
  combinedInboxAtsPriority,
  availableInboxAtsSystems,
  inboxAtsFilteredPage,
  orderAtsInboxCandidates,
  orderCombinedInboxCandidates,
  type CombinedInboxCandidate,
  type InboxListCandidate,
} from '../inboxEnteredAt';
import { prisma } from '../prisma';

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

function listCandidate(
  id: string,
  overrides: Partial<InboxListCandidate> = {},
): InboxListCandidate {
  return {
    ...candidate(id, '2026-09-04T12:00:00Z', 'LinkedIn', 70),
    createdAt: new Date('2026-09-04T10:00:00Z'),
    reqFitScore: 65,
    ...overrides,
  };
}

test('ATS filtering matches the card label across source, manual selection, and URL detection', () => {
  const rows = [
    listCandidate('source', { source: 'ATS-workday' }),
    listCandidate('manual', { manualAts: 'Greenhouse' }),
    listCandidate('url', { url: 'https://jobs.lever.co/acme/role-1' }),
    listCandidate('unknown'),
  ];

  assert.deepEqual(orderAtsInboxCandidates(rows, 'Greenhouse', 'newest').map((row) => row.id), ['manual']);
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Workday', 'newest').map((row) => row.id), ['source']);
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Lever', 'newest').map((row) => row.id), ['url']);
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Unknown', 'newest').map((row) => row.id), ['unknown']);
});

test('ATS choices include only represented card labels, with Unknown last', () => {
  const rows = [
    listCandidate('source', { source: 'ATS-workday' }),
    listCandidate('manual', { source: 'ATS-workday', manualAts: 'Greenhouse' }),
    listCandidate('url', { url: 'https://jobs.lever.co/acme/role-1' }),
    listCandidate('duplicate', { source: 'ATS-workday' }),
    listCandidate('unknown', { manualAts: 'JobPosting JSON-LD' }),
  ];
  assert.deepEqual(availableInboxAtsSystems(rows), ['Greenhouse', 'Lever', 'Workday', 'Unknown']);
  assert.deepEqual(availableInboxAtsSystems([]), []);
});

test('ATS choices cover the full Inbox before filtering and paging, and refresh as jobs leave', async t => {
  let rows = [
    listCandidate('a', { source: 'ATS-workday' }),
    listCandidate('b', { source: 'ATS-workday' }),
    listCandidate('c', { source: 'ATS-lever' }),
    listCandidate('unknown'),
  ];
  const originalQuery = prisma.$queryRaw;
  Reflect.set(prisma, '$queryRaw', async () => rows);
  t.after(() => { Reflect.set(prisma, '$queryRaw', originalQuery); });
  const first = await inboxAtsFilteredPage('Workday', 'newest', 1, 0);
  assert.deepEqual(first, { ids: ['a'], total: 2, atsOptions: ['Lever', 'Workday', 'Unknown'] });
  assert.deepEqual(await inboxAtsFilteredPage('Workday', 'newest', 1, 1), {
    ids: ['b'], total: 2, atsOptions: first.atsOptions,
  });
  assert.deepEqual(await inboxAtsFilteredPage('Unknown', 'newest', 1, 0), {
    ids: ['unknown'], total: 1, atsOptions: first.atsOptions,
  });
  rows = rows.filter(row => row.id !== 'c');
  assert.deepEqual(await inboxAtsFilteredPage('Lever', 'newest', 1, 0), {
    ids: [], total: 0, atsOptions: ['Workday', 'Unknown'],
  });
});

test('Oracle ingestion and employer URLs share one selectable provider label', () => {
  const rows = [
    listCandidate('source', { source: 'ATS-oracle' }),
    listCandidate('url', { url: 'https://careers.example.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123' }),
  ];
  assert.deepEqual(availableInboxAtsSystems(rows), ['Oracle Cloud']);
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Oracle Cloud', 'newest').map(row => row.id), ['source', 'url']);
});

test('ATS filtering keeps every Inbox sort and its stable tie-breakers', () => {
  const rows = [
    listCandidate('lower-newer', {
      source: 'ATS-lever', aimFitScore: 60, reqFitScore: 55,
      enteredInboxAt: new Date('2026-09-05T12:00:00Z'),
      createdAt: new Date('2026-09-05T10:00:00Z'),
    }),
    listCandidate('higher-older', {
      source: 'ATS-lever', aimFitScore: 90, reqFitScore: 85,
      enteredInboxAt: new Date('2026-09-04T12:00:00Z'),
      createdAt: new Date('2026-09-04T10:00:00Z'),
    }),
  ];

  assert.deepEqual(orderAtsInboxCandidates(rows, 'Lever', 'newest').map((row) => row.id), ['lower-newer', 'higher-older']);
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Lever', 'oldest').map((row) => row.id), ['higher-older', 'lower-newer']);
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Lever', 'aim_fit').map((row) => row.id), ['higher-older', 'lower-newer']);
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Lever', 'experience_fit').map((row) => row.id), ['higher-older', 'lower-newer']);
});

test('Acosta channel sales is first under every Inbox sort, before pagination', () => {
  const rows = [
    listCandidate('ordinary', { source: 'ATS-oracle', aimFitScore: 100, reqFitScore: 100, enteredInboxAt: new Date('2026-10-20T12:00Z') }),
    listCandidate('acosta-priority', { source: 'ATS-oracle', company: 'Acosta', title: 'Google Channel Sales Manager', aimFitScore: null, reqFitScore: null }),
    listCandidate('unrelated-mosaic', { source: 'ATS-oracle', company: 'The Mosaic Company', title: 'Channel Sales Manager' }),
  ];
  for (const sort of ['combined', 'newest', 'oldest', 'aim_fit', 'experience_fit']) {
    for (const filter of [null, 'Oracle Cloud']) {
      const ordered = orderAtsInboxCandidates(rows, filter, sort);
      assert.equal(ordered[0].id, 'acosta-priority', `${sort}/${filter}`);
      assert.deepEqual(ordered.slice(0, 1).map((row) => row.id), ['acosta-priority']);
      assert.equal(ordered.slice(1).some((row) => row.id === 'acosta-priority'), false);
    }
  }
  assert.deepEqual(orderAtsInboxCandidates(rows, 'Greenhouse', 'combined'), []);
});
