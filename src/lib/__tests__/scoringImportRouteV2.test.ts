import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(path.join(process.cwd(), 'src/app/api/scoring/import/route.ts'), 'utf8');
const importer = readFileSync(path.join(process.cwd(), 'src/lib/scoringImport.ts'), 'utf8');
const runImporter = readFileSync(path.join(process.cwd(), 'src/lib/scoringRunImport.ts'), 'utf8');

test('manual import route keeps preview and token-bound apply separate', () => {
  assert.match(source, /body\.mode !== 'preview' && body\.mode !== 'apply'/);
  assert.match(source, /previewScoringImport\(prisma, payload\)/);
  assert.match(source, /previewScoringRunImport\(prisma, payload\)/);
  assert.match(source, /SCORING_RUN_RESULT_SCHEMA/);
  assert.match(source, /readScoringMutationJson\(request, MAX_SCORING_RUN_EXCHANGE_BYTES\)/);
  assert.match(source, /approvalToken is required for apply/);
  assert.match(source, /applyScoringImport\(prisma, payload, body\.approvalToken\)/);
  assert.match(source, /applyScoringRunImport\(prisma, payload, body\.approvalToken\)/);
  assert.doesNotMatch(source, /reconcileScoringInputVersions|scoringInputReconciliation/);
  assert.match(importer, /run child results must be imported through their parent scoring run/);
  assert.match(runImporter, /allowRunChild: true/);
});
