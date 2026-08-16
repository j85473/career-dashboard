import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(path.join(process.cwd(), 'src/app/api/scoring/export/route.ts'), 'utf8');
const exporter = readFileSync(path.join(process.cwd(), 'src/lib/scoringExport.ts'), 'utf8');
const batch = readFileSync(path.join(process.cwd(), 'src/lib/scoringBatch.ts'), 'utf8');
const scoringLog = readFileSync(path.join(process.cwd(), 'src/components/ScoringLogTab.tsx'), 'utf8');

test('v2 export route keeps both stages available with a 30-job default', () => {
  assert.match(source, /body\.stage !== 'aim' && body\.stage !== 'experience'/);
  assert.match(source, /body\.limit === undefined \? 30/);
  assert.match(source, /exportScoringBatch\(prisma, body\.stage, limit\)/);
  assert.doesNotMatch(source, /EXPORT_ENABLED|export is disabled|scoringRuntimeConfig/);
  assert.match(scoringLog, /'Export Batch'/);
  assert.match(scoringLog, /Drop result JSON here/);
  assert.match(scoringLog, /onDrop=\{handleImportDrop\}/);
  assert.match(scoringLog, /Import .* scoring result JSON/);
  assert.doesNotMatch(scoringLog, /Preview Results|Export Aim Batch|Export Experience Batch/);
  assert.doesNotMatch(scoringLog, /Active Aim failure suppressions|Download one-job retry|\/api\/scoring\/failures/);
  assert.match(scoringLog, /send.*unscored job\(s\) to Action Needed/);
  assert.match(batch, /START-AIM-FIT-/);
  assert.match(batch, /START-E-FIT-/);
  assert.match(scoringLog, /START-AIM-FIT-/);
  assert.match(scoringLog, /START-E-FIT-/);
  assert.doesNotMatch(scoringLog, /career-dashboard-\$\{stage\}-export|career-dashboard-aim-retry/);
  assert.match(exporter, /limit > 30/);
  assert.match(exporter, /limit = 30/);
  assert.match(exporter, /manualScoringStatusWhere\('aim'\)/);
  assert.match(exporter, /manualScoringStatusWhere\('experience'\)/);
  assert.match(exporter, /orderBy: aimScoringPriorityOrder\(\)/);
  assert.match(scoringLog, /sort: currentTab === 'aim_fit' \? 'aim_priority' : 'newest'/);
  assert.doesNotMatch(exporter, /Math\.min\(limit, 20\)/);
  assert.match(batch, /input\.schemaVersion\.endsWith\('-v2'\) \? 30 : 50/);

  for (const filename of [
    'aim-export-v2.schema.json',
    'aim-result-v2.schema.json',
    'experience-export-v2.schema.json',
    'experience-result-v2.schema.json',
  ]) {
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), 'data/scoring/schemas', filename), 'utf8'));
    const collection = filename.includes('export') ? schema.properties.jobs : schema.properties.results;
    assert.equal(collection.maxItems, 30, filename);
  }
});
