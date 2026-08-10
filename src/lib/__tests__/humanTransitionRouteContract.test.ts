import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const route = (...parts: string[]) => readFileSync(
  path.join(process.cwd(), 'src', 'app', 'api', 'jobs', '[id]', ...parts),
  'utf8',
);

test('human inbox and rejection routes lock, mutate, and emit in one transaction', () => {
  for (const source of [route('route.ts'), route('promote', 'route.ts'), route('pass', 'route.ts')]) {
    assert.match(source, /\$transaction\(async \(tx\)/);
    assert.match(source, /FOR UPDATE/);
    assert.match(source, /recordJobPipelineEvent\(\{/);
    assert.match(source, /\}, tx\);/);
  }
});

test('generic status patch derives events from prior, requested, and final status', () => {
  const source = route('route.ts');
  assert.match(source, /humanLifecycleEvent\(lockedPrior\.status, status, updated\.status\)/);
});

test('event writer uses conflict-safe upsert for deterministic keys', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'lib', 'ingestionControl.ts'), 'utf8');
  assert.match(source, /jobPipelineEvent\.upsert\(\{/);
  assert.match(source, /where: \{ eventKey \}/);
  assert.match(source, /update: \{\}/);
});
