import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MANUAL_SCORING_BATCH_SIZE } from '../scoringLimits';

const source = readFileSync(path.join(process.cwd(), 'src/app/api/scoring/export/route.ts'), 'utf8');
const exporter = readFileSync(path.join(process.cwd(), 'src/lib/scoringExport.ts'), 'utf8');
const aimExporter = exporter.slice(
  exporter.indexOf('async function prepareAim('),
  exporter.indexOf('function aimBatchInput'),
);
const experienceExporter = exporter.slice(
  exporter.indexOf('async function prepareExperience'),
  exporter.indexOf('export async function exportScoringBatch'),
);
const batch = readFileSync(path.join(process.cwd(), 'src/lib/scoringBatch.ts'), 'utf8');
const scoringLog = readFileSync(path.join(process.cwd(), 'src/components/ScoringLogTab.tsx'), 'utf8');
const runnerProtocol = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data/scoring/runner-protocol-v2.json'), 'utf8'),
) as { limits: { maximumAimJobsPerBatch: number; maximumExperienceJobsPerBatch: number } };

test('v2 export route keeps both stages available with one shared 50-job limit', () => {
  assert.equal(MANUAL_SCORING_BATCH_SIZE, 50);
  assert.match(source, /body\.stage !== 'aim' && body\.stage !== 'experience'/);
  assert.match(source, /body\.limit === undefined \? MANUAL_SCORING_BATCH_SIZE/);
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
  assert.match(exporter, /limit > MANUAL_SCORING_BATCH_SIZE/);
  assert.match(exporter, /limit = MANUAL_SCORING_BATCH_SIZE/);
  assert.match(exporter, /manualScoringStatusWhere\('aim'\)/);
  assert.match(exporter, /manualScoringStatusWhere\('experience'\)/);
  assert.match(aimExporter, /while \(prepared\.length < limit && !exhausted\)/);
  assert.match(aimExporter, /skip: offset/);
  assert.match(aimExporter, /offset \+= candidates\.length/);
  assert.doesNotMatch(aimExporter, /take: Math\.min\(limit \* 5, 250\)/);
  assert.match(experienceExporter, /while \(prepared\.length < limit && !exhausted\)/);
  assert.match(experienceExporter, /skip: offset/);
  assert.match(experienceExporter, /offset \+= candidates\.length/);
  assert.doesNotMatch(experienceExporter, /take: Math\.min\(limit \* 5, 250\)/);
  assert.match(exporter, /orderBy: aimScoringPriorityOrder\(\)/);
  assert.match(scoringLog, /sort: currentTab === 'aim_fit' \? 'aim_priority' : 'newest'/);
  assert.doesNotMatch(exporter, /Math\.min\(limit, 20\)/);
  assert.match(batch, /const maximum = MANUAL_SCORING_BATCH_SIZE/);
  assert.match(scoringLog, /limit: MANUAL_SCORING_BATCH_SIZE/);
  assert.equal(runnerProtocol.limits.maximumAimJobsPerBatch, MANUAL_SCORING_BATCH_SIZE);
  assert.equal(runnerProtocol.limits.maximumExperienceJobsPerBatch, MANUAL_SCORING_BATCH_SIZE);

  for (const filename of [
    'aim-export-v2.schema.json',
    'aim-result-v2.schema.json',
    'experience-export-v2.schema.json',
    'experience-result-v2.schema.json',
  ]) {
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), 'data/scoring/schemas', filename), 'utf8'));
    const collection = filename.includes('export') ? schema.properties.jobs : schema.properties.results;
    const itemDefinition = String(collection.items.$ref).split('/').at(-1);
    assert.ok(itemDefinition, `${filename} item schema reference is missing`);
    const itemSchema = schema.$defs[itemDefinition];
    assert.equal(collection.maxItems, MANUAL_SCORING_BATCH_SIZE, filename);
    assert.equal(itemSchema.properties.ordinal.maximum, MANUAL_SCORING_BATCH_SIZE - 1, filename);
  }
});
