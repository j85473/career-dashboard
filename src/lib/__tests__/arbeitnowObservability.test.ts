import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ARBEITNOW_REQUEST_TIMEOUT_MS,
  ArbeitnowStageError,
  runArbeitnowProvider,
} from '../jobIngestion';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Arbeitnow identifies reservation failure before any fetch begins', async () => {
  let fetched = false;
  await assert.rejects(
    runArbeitnowProvider({
      reserveRequest: async () => { throw new Error('Arbeitnow request blocked by daily_budget'); },
      fetchFn: async () => {
        fetched = true;
        return jsonResponse({ data: [] });
      },
      processJob: async () => 'inserted',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArbeitnowStageError);
      assert.equal(error.stage, 'reservation');
      assert.match(error.message, /daily_budget/);
      return true;
    },
  );
  assert.equal(fetched, false);
});

test('Arbeitnow uses the bounded ingestion timeout and identifies transport aborts', async () => {
  let timeoutMs: number | null = null;
  const timeout = AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));

  await assert.rejects(
    runArbeitnowProvider({
      reserveRequest: async () => {},
      timeoutSignal: (milliseconds) => {
        timeoutMs = milliseconds;
        return timeout;
      },
      fetchFn: async (url, init) => {
        assert.equal(url, 'https://www.arbeitnow.com/api/job-board-api');
        assert.equal(init?.signal, timeout);
        throw timeout.reason;
      },
      processJob: async () => 'inserted',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArbeitnowStageError);
      assert.equal(error.stage, 'fetch');
      assert.match(error.message, /timed out or was aborted/);
      return true;
    },
  );

  assert.equal(timeoutMs, ARBEITNOW_REQUEST_TIMEOUT_MS);
  assert.equal(ARBEITNOW_REQUEST_TIMEOUT_MS, 20_000);
});

test('Arbeitnow distinguishes an HTTP response failure from transport failure', async () => {
  await assert.rejects(
    runArbeitnowProvider({
      reserveRequest: async () => {},
      fetchFn: async () => jsonResponse({}, 503),
      processJob: async () => 'inserted',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArbeitnowStageError);
      assert.equal(error.stage, 'http');
      assert.match(error.message, /HTTP 503/);
      return true;
    },
  );
});

test('Arbeitnow payload failures never expose raw response text in evidence', async () => {
  const rawPayload = 'private-provider-payload-marker';
  await assert.rejects(
    runArbeitnowProvider({
      reserveRequest: async () => {},
      fetchFn: async () => new Response(rawPayload, { status: 200 }),
      processJob: async () => 'inserted',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ArbeitnowStageError);
      assert.equal(error.stage, 'payload');
      assert.doesNotMatch(error.message, new RegExp(rawPayload));
      return true;
    },
  );
});

test('Arbeitnow records a valid empty response as zero-result idle', async () => {
  let processed = 0;
  const evidence = await runArbeitnowProvider({
    reserveRequest: async () => {},
    fetchFn: async () => jsonResponse({ data: [] }),
    processJob: async () => {
      processed++;
      return 'inserted';
    },
  });

  assert.deepEqual(evidence, {
    phase: 'zero_result',
    payloadCount: 0,
    eligibleCount: 0,
    processingAttempts: 0,
    processedCount: 0,
    processingErrorCount: 0,
  });
  assert.equal(processed, 0);
});

test('Arbeitnow preserves its title and US-location filters and records successful processing', async () => {
  const processed: Array<Record<string, unknown>> = [];
  const evidence = await runArbeitnowProvider({
    reserveRequest: async () => {},
    fetchFn: async () => jsonResponse({
      data: [
        {
          title: 'Regional Sales Manager',
          company_name: 'Example Co',
          description: 'Role description',
          location: 'Remote, USA',
          url: 'https://example.test/jobs/regional-sales',
          slug: 'regional-sales',
          created_at: 1_787_520_000,
        },
        { title: 'Regional Sales Manager', location: 'Berlin, Germany', slug: 'germany-sales' },
        { title: 'Software Engineer', location: 'Remote, United States', slug: 'us-engineer' },
      ],
    }),
    processJob: async (job) => {
      processed.push(job as Record<string, unknown>);
      return 'inserted';
    },
  });

  assert.deepEqual(evidence, {
    phase: 'processing_complete',
    payloadCount: 3,
    eligibleCount: 1,
    processingAttempts: 1,
    processedCount: 1,
    processingErrorCount: 0,
  });
  assert.equal(processed.length, 1);
  assert.equal(processed[0].title, 'Regional Sales Manager');
  assert.equal(processed[0].location, 'Remote, USA');
  assert.equal(processed[0].source, 'Arbeitnow');
  assert.equal(processed[0].sourceId, 'regional-sales');
});

test('Arbeitnow terminal stage evidence is persisted through the existing source-run checkpoint', () => {
  const source = readFileSync('src/lib/jobIngestion.ts', 'utf8');
  assert.match(source, /statsFor\('Arbeitnow'\)\.stageEvidence = evidence/);
  assert.match(source, /providerStage: stats\.stageEvidence/);
  assert.match(source, /statsFor\('Arbeitnow'\)\.stageEvidence = \{ phase \}/);
});
