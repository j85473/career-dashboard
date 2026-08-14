import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(path.join(process.cwd(), 'src/app/api/scoring/export/route.ts'), 'utf8');

test('v2 export route checks the stage gate before any durable export call', () => {
  const gate = source.indexOf('if (!enabled)');
  const write = source.indexOf('exportScoringBatch(');
  assert.ok(gate >= 0 && write > gate);
  assert.match(source, /status: 503/);
  assert.match(source, /aimScoringV2ExportEnabled/);
  assert.match(source, /experienceScoringV2ExportEnabled/);
});
