import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(path.join(process.cwd(), 'src/app/api/scoring/import/route.ts'), 'utf8');

test('manual import route keeps preview and token-bound apply separate', () => {
  assert.match(source, /body\.mode !== 'preview' && body\.mode !== 'apply'/);
  assert.match(source, /previewScoringImport\(prisma, payload\)/);
  assert.match(source, /approvalToken is required for apply/);
  assert.match(source, /applyScoringImport\(prisma, payload, body\.approvalToken\)/);
  assert.doesNotMatch(source, /reconcileScoringInputVersions|scoringInputReconciliation/);
});
