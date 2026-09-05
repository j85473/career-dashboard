import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  TICKER_FALLBACK_MESSAGE,
  currentTickerMessage,
  describeAtsBatchChunk,
  atsAcquisitionNote,
  atsAcquisitionStateLabel,
  atsThroughputLabel,
  atsWeekHealth,
  describeAtsBatchJob,
  formatAtsBackpressureTelemetry,
  parseAtsAcquisitionDetail,
  parseAtsStageDetail,
  pipelineStatusRows,
  rollingTickerMessageQueue,
} from '../pipelineTelemetry';

test('the ticker preserves entered text and rolls the newest update in next', () => {
  assert.deepEqual(rollingTickerMessageQueue(
    ['ATS processing: visible-company', 'ATS processing: entering-company', 'ATS processing: unseen-copy'],
    2,
    'ATS processing: current-company - processing job 8 of 25',
  ), [
    'ATS processing: visible-company',
    'ATS processing: entering-company',
    'ATS processing: current-company - processing job 8 of 25',
  ]);
});

test('the ticker coalesces updates that have not entered the viewport yet', () => {
  assert.deepEqual(rollingTickerMessageQueue(
    ['ATS processing: visible-company', 'ATS processing: superseded-before-entry'],
    1,
    'ATS processing: newest-company',
  ), [
    'ATS processing: visible-company',
    'ATS processing: newest-company',
  ]);
});

test('blank ticker telemetry has one consistent fallback', () => {
  assert.equal(currentTickerMessage(''), TICKER_FALLBACK_MESSAGE);
  assert.equal(currentTickerMessage('   '), TICKER_FALLBACK_MESSAGE);
  assert.equal(currentTickerMessage(null), TICKER_FALLBACK_MESSAGE);
});

test('the expanded concurrent status has one stable row per pipeline lane', () => {
  assert.deepEqual(
    pipelineStatusRows(
      'Dejobs (source_feed/channel development manager): Navigating to page 2... | ATS acquisition PID 586172: bamboohr:tdh | Backpressure: Normal · 842 awaiting persistence (pauses at 2,000) · 21,221 awaiting enrichment · 14,900 still listing | ATS processing: ashby:dex - processing job 4 of 7 | Local Scoring: Locally filtered Example Co | JD Extraction: 0 queued',
    ),
    [
      { id: 'ingestion', label: 'Source ingestion', value: 'Dejobs (source_feed/channel development manager): Navigating to page 2...' },
      { id: 'ats-acquisition', label: 'ATS acquisition', value: 'PID 586172 · bamboohr:tdh' },
      { id: 'backpressure', label: 'ATS stages', value: 'Normal · 842 awaiting persistence (pauses at 2,000) · 21,221 awaiting enrichment · 14,900 still listing' },
      { id: 'ats-processing', label: 'ATS processing', value: 'ashby:dex - processing job 4 of 7' },
      { id: 'local-scoring', label: 'Local scoring', value: 'Locally filtered Example Co' },
      { id: 'jd-extraction', label: 'JD extraction', value: '0 queued' },
    ],
  );
});

test('the backpressure lane separates the gated stage from the rest of the backlog', () => {
  // The gate counts only jobs in synchronized payloads, which the persistence
  // stage keeps near zero. Reported alone it reads healthy at exactly the moment
  // acquisition is backed up, so the lane must name all three stages and mark
  // which one the watermark applies to.
  const [backpressure] = pipelineStatusRows(
    'Ingestion: idle | ATS acquisition PID 1: workday:acme | Backpressure: Normal \u00b7 0 awaiting persistence (pauses at 2,000) \u00b7 21,221 awaiting enrichment \u00b7 14,900 still listing | ATS processing: idle | Local Scoring: idle | JD Extraction: 0 queued',
  ).filter((row) => row.id === 'backpressure');
  assert.equal(
    backpressure.value,
    'Normal \u00b7 0 awaiting persistence (pauses at 2,000) \u00b7 21,221 awaiting enrichment \u00b7 14,900 still listing',
  );
  // A zero gate must not be presentable as an empty backlog.
  assert.match(backpressure.value, /21,221 awaiting enrichment/);
  assert.match(backpressure.value, /14,900 still listing/);
});

test('combined backlog telemetry names the drain and every v2 lifecycle stage', () => {
  assert.equal(formatAtsBackpressureTelemetry({
    active: true,
    remainingJobs: 881,
    highWatermark: 2_000,
    lowWatermark: 1_000,
    enrichmentJobs: 38_916,
    listingJobs: 33_960,
    compactionJobs: 412,
    publicationJobs: 653,
    terminalUnsealedJobs: 153,
    sealedUnpublishedJobs: 500,
    publishedUnpersistedJobs: 881,
    admissionState: 'draining',
    publicationPaused: true,
    legacyPersistenceJobs: 0,
    v2PersistenceJobs: 881,
    observedAt: '2026-08-31T19:30:00.000Z',
  }), 'Backpressure: Flow Admissions paused · Listing 33,960 · Compaction 412 · Enrichment 38,916 · Sealing 153 · Publication 500 · Normalization & persistence 881 · Pause 2,000 · Resume 1,000');
});

test('structured ATS telemetry parses the rotation reading and ordered lifecycle stages', () => {
  assert.deepEqual(
    parseAtsAcquisitionDetail(
      'State waiting · Rotation Saturday · Boards 7432/7645 · Ready 0 · '
      + 'Unlock 2026-09-05T15:58:08.913Z · Unlocking 83 · Lanes 8/8 · Rate 24 · '
      + 'Week 48127/51826',
    ),
    {
      kind: 'ats-acquisition',
      state: 'waiting',
      rotationDay: 'Saturday',
      swept: 7_432,
      total: 7_645,
      readyNow: 0,
      nextUnlockAt: '2026-09-05T15:58:08.913Z',
      unlockWithinHour: 83,
      lanesBusy: 8,
      lanesTotal: 8,
      boardsPerHour: 24,
      weekCovered: 48_127,
      weekActive: 51_826,
    },
  );
  // A line without a recognised state is not an acquisition reading, and must
  // fall through to the raw text rather than render as a panel of zeroes.
  assert.equal(parseAtsAcquisitionDetail('Workers 8/8 lanes · Today complete 1/2 · Running'), undefined);
  // A reader that predates a new segment still gets every field it knows.
  const partial = parseAtsAcquisitionDetail(
    'State working · Rotation Monday · Boards 10/20 · Lanes 4/8 · Rate 90 · Week 5/10 · Horizon 3',
  );
  assert.equal(partial?.kind === 'ats-acquisition' && partial.nextUnlockAt, null);
  assert.equal(partial?.kind === 'ats-acquisition' && partial.boardsPerHour, 90);
  assert.deepEqual(
    parseAtsStageDetail(
      'Flow Normal · Listing 7,870 · Compaction 12 · Enrichment 1,324 · Sealing 789 · Publication 31 · Normalization & persistence 61 · Pause 2,000 · Resume 1,000',
    ),
    {
      kind: 'ats-stages',
      flow: 'Normal',
      pauseAt: 2_000,
      resumeAt: 1_000,
      stages: [
        { id: 'listing', label: 'Listing', value: 7_870 },
        { id: 'compaction', label: 'Compaction', value: 12 },
        { id: 'enrichment', label: 'Enrichment', value: 1_324 },
        { id: 'sealing', label: 'Sealing', value: 789 },
        { id: 'publication', label: 'Publication', value: 31 },
        { id: 'persistence', label: 'Normalization & persistence', value: 61 },
      ],
    },
  );
});

test('the expanded status preserves a backpressure lane for legacy five-lane telemetry', () => {
  const rows = pipelineStatusRows(
    'Ingestion: Idle | ATS acquisition: Ready | ATS processing: Idle | Local Scoring: Idle | JD Extraction: Idle',
  );

  assert.deepEqual(rows[2], {
    id: 'backpressure',
    label: 'ATS stages',
    value: 'Awaiting telemetry',
  });
  assert.equal(rows[3].value, 'Idle');
});

test('the expanded status keeps non-concurrent progress as one activity row', () => {
  assert.deepEqual(pipelineStatusRows('Initializing pipeline'), [
    { id: 'activity', label: 'Current activity', value: 'Initializing pipeline' },
  ]);
});

test('ATS processing describes the durable chunk instead of another network search', () => {
  const batch = {
    platform: 'workday',
    slug: 'example.wd1::careers',
    jobs: Array.from({ length: 25 }),
    processingOffset: 25,
    totalJobCount: 72,
  };

  assert.equal(
    describeAtsBatchChunk(batch),
    'Normalizing & persisting · workday / example.wd1::careers · jobs 26-50 of 72',
  );
  assert.equal(
    describeAtsBatchJob(batch, 4),
    'Normalizing & persisting · workday / example.wd1::careers · job 30 of 72',
  );
});

test('ATS processing labels an empty synchronized batch truthfully', () => {
  assert.equal(
    describeAtsBatchChunk({
      platform: 'greenhouse',
      slug: 'empty-board',
      jobs: [],
      processingOffset: 0,
      totalJobCount: 0,
    }),
    'Finalizing empty board · greenhouse / empty-board',
  );
});

test('the operator panel has fixed telemetry rows and structured ATS grids', () => {
  const component = readFileSync(path.join(process.cwd(), 'src/components/ScoringLogTab.tsx'), 'utf8');
  const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
  const route = readFileSync(path.join(process.cwd(), 'src/app/api/pipeline/run/route.ts'), 'utf8');

  assert.match(component, /pipeline-acquisition-detail/);
  assert.match(component, /pipeline-stage-grid/);
  assert.match(component, /completionPercent/);
  // Two kinds of row, sized on purpose.
  //
  // A plain telemetry row carries free-form ticker text whose length changes
  // constantly, so its height stays hard and the text is clamped to whole
  // lines. That is what keeps the panel from resizing as telemetry arrives.
  assert.match(css, /\.pipeline-status-row \{[^}]*height: 54px;[^}]*overflow: hidden;/);
  assert.match(css, /\.pipeline-status-text \{[^}]*-webkit-line-clamp: 2;/);
  // The two structured rows render a constant number of lines and every
  // varying value inside them is nowrap, so they cannot cause that resizing.
  // They take the height their content needs and then hold it: a fixed height
  // here cropped the ATS grids mid-line on iOS, where the cohort percentage
  // wraps to its own row and the font metrics differ from the ones these pixel
  // values were measured against.
  assert.match(
    css,
    /\.pipeline-status-row--ats-acquisition, \.pipeline-status-row--backpressure \{ height: auto; min-height: 124px; overflow: visible; \}/,
  );
  assert.match(
    css,
    /\.pipeline-status-row--ats-acquisition dd, \.pipeline-status-row--backpressure dd \{ height: auto; overflow: visible; \}/,
  );
  // The desktop card is the same width as the Manual Exchange card and uses
  // tighter fixed rows. That shortens the panel without hiding live values.
  assert.match(css, /@media \(min-width: 761px\) \{[\s\S]*?\.pipeline-running-status \{ display: block; width: 100%; \}/);
  assert.match(css, /@media \(min-width: 761px\) \{[\s\S]*?\.pipeline-status-row \{[^}]*height: 44px;[^}]*padding: 4px 16px;/);
  assert.match(css, /@media \(min-width: 761px\) \{[\s\S]*?\.pipeline-status-row--ats-acquisition, \.pipeline-status-row--backpressure \{ min-height: 84px; \}/);
  // The mobile overrides must keep the same split.
  assert.match(css, /\.pipeline-status-row \{ grid-template-columns: 1fr; gap: 3px; height: 72px; \}/);
  assert.match(css, /\.pipeline-status-row--ats-acquisition \{ height: auto; min-height: 178px; \}/);
  assert.match(css, /\.pipeline-status-row--backpressure \{ height: auto; min-height: 205px; \}/);
  assert.match(route, /Idle · waiting for published ATS segments/);
});

test('every acquisition reading says which kind of zero it is', () => {
  const base = {
    kind: 'ats-acquisition' as const,
    state: 'waiting' as const,
    rotationDay: 'Saturday',
    swept: 7_432,
    total: 7_645,
    readyNow: 0,
    nextUnlockAt: '2026-09-05T16:02:56.990Z',
    unlockWithinHour: 83,
    lanesBusy: 8,
    lanesTotal: 8,
    boardsPerHour: 0,
    weekCovered: 48_127,
    weekActive: 51_826,
  };

  // Held behind a timer. The count of what is left has to arrive with the time
  // it unlocks, or this reads exactly like a hang.
  const waiting = atsAcquisitionNote(base);
  assert.match(waiting, /213 left/);
  assert.match(waiting, /none ready yet/);
  assert.match(waiting, /next unlocks 11:02 AM/);
  assert.match(waiting, /83 within the hour/);

  // Waiting with nothing scheduled must not silently claim a next unlock.
  assert.match(
    atsAcquisitionNote({ ...base, nextUnlockAt: null }),
    /nothing scheduled to unlock/,
  );
  // Nothing unlocking within the hour must not print a bare zero.
  assert.doesNotMatch(
    atsAcquisitionNote({ ...base, unlockWithinHour: 0 }),
    /0 within the hour/,
  );

  // Lanes held, work ready, nothing landing. This is the only reading that
  // should send Joseph looking.
  assert.match(
    atsAcquisitionNote({ ...base, state: 'stuck', readyNow: 1_900 }),
    /nothing completed in over 30 minutes, and 1,900 boards are ready/,
  );
  // A finished rotation is not a stall.
  assert.match(
    atsAcquisitionNote({ ...base, state: 'done', swept: 7_645 }),
    /every Saturday board swept/,
  );
  assert.match(atsAcquisitionNote({ ...base, state: 'blocked' }), /admissions are paused/);
  assert.match(atsAcquisitionNote({ ...base, state: 'stopped' }), /no worker lanes are leased/);
  assert.match(
    atsAcquisitionNote({ ...base, state: 'working', readyNow: 940 }),
    /213 left · 940 ready now/,
  );

  // Throughput of nothing is a sentence, never a zero.
  assert.equal(atsThroughputLabel(0), 'no boards completed this hour');
  assert.equal(atsThroughputLabel(1_204), '1,204 boards/hr');

  assert.equal(atsAcquisitionStateLabel('stuck'), 'Stuck');

  // The week rides beside the day so seven good-looking days cannot hide a bad
  // week. 48,127 of 51,826 is the live reading, and at 93% it is under both the
  // 99% coverage objective and the slipping band, so it must not read green.
  assert.deepEqual(atsWeekHealth(48_127, 51_826), { label: 'week behind (93%)', tone: 'bad' });
  assert.equal(atsWeekHealth(49_500, 51_826).tone, 'warn');
  assert.equal(atsWeekHealth(51_400, 51_826).tone, 'good');
  assert.equal(atsWeekHealth(40_000, 51_826).tone, 'bad');
  assert.equal(atsWeekHealth(0, 0).tone, 'idle');
});

test('a dead or unreadable pipeline cannot leave a confident acquisition panel behind', () => {
  // stepProgress is a durable row. If the poller that writes it dies, the row
  // freezes, and the danger is that a stale reading keeps rendering as a live
  // one. Both failure messages the status route can substitute must fall all
  // the way through to plain text rather than parse into a panel.
  for (const frozen of ['Pipeline timed out or crashed.', 'Unable to read pipeline state.']) {
    const rows = pipelineStatusRows(frozen);
    assert.ok(rows.every((row) => row.detail === undefined), frozen);
  }
  // The same rule covers a reading from before the labelled transport existed.
  assert.equal(
    parseAtsAcquisitionDetail('Workers 8/8 lanes · Today complete 6,481/7,645 · Running'),
    undefined,
  );
});
