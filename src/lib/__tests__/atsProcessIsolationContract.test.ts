import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const routePath = path.resolve(process.cwd(), 'src/app/api/pipeline/run/route.ts');
const loopPath = path.resolve(process.cwd(), 'src/lib/atsAcquisitionLoop.ts');
const processPath = path.resolve(process.cwd(), 'src/lib/pipelineWorkerProcess.ts');
const workerPath = path.resolve(process.cwd(), 'scripts/workers/ats-acquisition.ts');
const ingestionPath = path.resolve(process.cwd(), 'src/lib/jobIngestion.ts');

test('pipeline route supervises exactly one isolated acquisition launcher and always drains batches', () => {
  const route = readFileSync(routePath, 'utf8');

  assert.match(route, /export const runtime = 'nodejs'/);
  assert.equal(route.match(/runAtsAcquisitionWorkerProcess\(\{/g)?.length, 1);
  assert.match(route, /superviseLoop\('ATS Acquisition Process', runAtsAcquisitionProcess\)/);
  assert.match(route, /await loopFn\(\)/);
  assert.match(route, /let latestBackpressure = ATS_SPLIT_INGESTION_ENABLED/);
  assert.match(route, /\$\{latestAtsAcquisition\} \| \$\{latestBackpressure\} \| \$\{latestAtsProcessing\}/);
  assert.match(route, /onBackpressure: \(_pid, telemetry\) =>/);
  assert.match(route, /formatAtsBackpressureTelemetry\(telemetry\)/);
  assert.doesNotMatch(route, /acquireAtsBoardBatch|selectDueAtsBoards|atsQueueDepth/);

  const joinIndex = route.indexOf('await Promise.allSettled([');
  const batchConsumerIndex = route.indexOf("superviseLoop('ATS Batch Processing', runAtsBatchProcessingLoop)");
  const releaseIndex = route.lastIndexOf('await releaseLock()');
  assert.ok(joinIndex >= 0 && batchConsumerIndex > joinIndex, 'batch consumer must be in the unconditional supervisor join');
  assert.ok(releaseIndex > batchConsumerIndex, 'global lock must be released only after the child supervisor join settles');
});

test('a platform-wide ATS cooldown defers the durable consumer chunk instead of consuming detail-less jobs', () => {
  const ingestion = readFileSync(ingestionPath, 'utf8');

  assert.match(ingestion, /export class AtsPlatformDeferredError extends Error/);
  assert.match(ingestion, /throw new AtsPlatformDeferredError\(atsDetailMatch\[1\], platformDecision\.retryAt\)/);
  assert.equal(
    ingestion.match(/if \(e instanceof AtsPlatformDeferredError\) throw e;/g)?.length,
    7,
    'every ATS detail adapter must propagate the durable platform deferral',
  );
  assert.match(ingestion, /ingestionInterruptionReason \|\|= err\.message/);
});

test('a prefetched ATS item consumes the child marker and cannot enter parent network fallbacks', () => {
  const ingestion = readFileSync(ingestionPath, 'utf8');

  assert.match(ingestion, /readAtsJobEnrichmentMarker\(job\)/);
  assert.match(ingestion, /isAtsJobEnrichmentMarker\(storedAtsEnrichmentMarker\)/);
  assert.match(ingestion, /storedAtsEnrichmentMarker\.version !== ATS_JOB_ENRICHMENT_VERSION/);
  assert.match(ingestion, /storedAtsEnrichmentMarker\.platform !== board\.platform/);
  const markerValidationIndex = ingestion.indexOf('const prefetchedAtsEnrichmentMarkers');
  const processingIndex = ingestion.indexOf('// Process jobs', markerValidationIndex);
  assert.ok(markerValidationIndex >= 0 && processingIndex > markerValidationIndex);
  assert.match(ingestion.slice(markerValidationIndex, processingIndex), /throw new Error\(/);
  for (const override of ['description', 'company', 'location', 'compensation']) {
    assert.match(ingestion, new RegExp(`atsEnrichmentMarker\\?\\.${override}`));
  }

  assert.match(ingestion, /const parentAtsNetworkAllowed = !options\.prefetchedAtsBatch/);
  for (const platform of [
    'workday',
    'smartrecruiters',
    'workable',
    'bamboohr',
    'breezy',
    'teamtailor',
    'rippling',
  ]) {
    assert.match(
      ingestion,
      new RegExp(`if \\(parentAtsNetworkAllowed && board\\.platform === ["']${platform}["']`),
      `${platform} detail adapter must be unreachable for a prefetched batch`,
    );
  }
  const legacyDetailEnd = ingestion.indexOf('if (board.platform === "lever")', processingIndex);
  const legacyDetailBlock = ingestion.slice(processingIndex, legacyDetailEnd);
  assert.equal(legacyDetailBlock.match(/fetchAtsPlatformResponse\(board\.platform/g)?.length, 7);
  assert.equal(legacyDetailBlock.match(/if \(parentAtsNetworkAllowed &&/g)?.length, 7);

  assert.match(
    ingestion,
    /if \(\s*!networkComplete\s*&& glassdoorMetadataFilter[\s\S]*?resolveRedirectUrl[\s\S]*?resolveCanonicalUrl[\s\S]*?scrapeAtsApi[\s\S]*?tryFetchFullDescription[\s\S]*?\n\s*}\n/,
  );
  assert.match(ingestion, /processJobInternal\(jobData, atsBatchItem, networkComplete\)/);
  assert.match(ingestion, /options\.prefetchedAtsBatch \? true : false/);
});

test('worker boundary has structured IPC, attached exact-child termination, and no PipelineState writer', () => {
  const loop = readFileSync(loopPath, 'utf8');
  const processModule = readFileSync(processPath, 'utf8');
  const worker = readFileSync(workerPath, 'utf8');

  assert.doesNotMatch(loop, /updatePipelineState|pipelineState\.(?:update|upsert)/);
  assert.doesNotMatch(worker, /updatePipelineState|pipelineState\.(?:update|upsert)/);
  assert.match(processModule, /spawn\)\(launch\.executable, launch\.args, launch\.options\)/);
  assert.doesNotMatch(processModule, /\bfork\(/);
  assert.match(processModule, /detached: false/);
  assert.match(processModule, /child\.kill\('SIGTERM'\)/);
  assert.match(processModule, /child\.kill\('SIGKILL'\)/);
  assert.doesNotMatch(processModule, /process\.kill\(-/);
  assert.match(worker, /process\.once\('SIGTERM'/);
  assert.match(worker, /process\.once\('SIGINT'/);
  assert.match(worker, /process\.once\('disconnect'/);
  assert.match(loop, /onBackpressure\?: \(telemetry: AtsAcquisitionBackpressureTelemetry\) => void/);
  assert.equal(loop.match(/reportBackpressure\(backpressure\)/g)?.length, 2);
  assert.match(processModule, /input\.onBackpressure\?\.\(pid,/);
  assert.match(worker, /readAtsOperatorBacklogSnapshot\(\)/);
  assert.match(worker, /ATS_BACKLOG_TELEMETRY_INTERVAL_MS/);
  assert.doesNotMatch(worker, /onBackpressure: \(telemetry\)/);
  for (const type of ['ready', 'progress', 'backpressure', 'fatal', 'stopped']) {
    assert.match(worker, new RegExp(`type: '${type}'`));
  }
});
