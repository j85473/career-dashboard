import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const routes = [
  'jobs/export-ai/route.ts',
  'jobs/import-ai/route.ts',
  'jobs/retry/route.ts',
  'pipeline/context/route.ts',
  'pipeline/deepseek/route.ts',
  'scoring/requests/route.ts',
  'scoring/requests/[id]/retry/route.ts',
  'scoring/requests/[id]/cancel/route.ts',
  'scoring/requeue-local/route.ts',
];

test('exactly the nine retired product scoring routes remain HTTP 410 shims', () => {
  assert.equal(routes.length, 9);
  for (const relative of routes) {
    const source = readFileSync(path.join(process.cwd(), 'src/app/api', relative), 'utf8');
    assert.match(source, /nativeScoringRetiredResponse/);
    assert.doesNotMatch(source, /nativeScoringBatch|nativeScoringRequest|runAutomaticNativeScoring/);
  }
});
