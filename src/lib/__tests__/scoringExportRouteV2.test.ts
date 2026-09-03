import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  MANUAL_SCORING_BATCH_SIZE,
  MAX_SCORING_RUN_JOBS,
  SCORING_RUN_CHILD_BATCH_SIZE,
} from '../scoringLimits';

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
const run = readFileSync(path.join(process.cwd(), 'src/lib/scoringRun.ts'), 'utf8');
const runsRoute = readFileSync(path.join(process.cwd(), 'src/app/api/scoring/runs/route.ts'), 'utf8');
const scoringLog = readFileSync(path.join(process.cwd(), 'src/components/ScoringLogTab.tsx'), 'utf8');
const runnerProtocol = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data/scoring/runner-protocol-v2.json'), 'utf8'),
) as { limits: { maximumAimJobsPerBatch: number; maximumExperienceJobsPerBatch: number } };

test('exports cap each stage at 200 jobs without changing recoverable child contracts', () => {
  assert.equal(MANUAL_SCORING_BATCH_SIZE, 50);
  assert.equal(SCORING_RUN_CHILD_BATCH_SIZE, 40);
  assert.equal(MAX_SCORING_RUN_JOBS, 200);
  assert.match(source, /body\.stage !== 'aim' && body\.stage !== 'experience'/);
  assert.match(source, /exportScoringRun\(prisma, body\.stage\)/);
  assert.doesNotMatch(source, /body\.limit|exportScoringBatch/);
  assert.doesNotMatch(source, /EXPORT_ENABLED|export is disabled|scoringRuntimeConfig/);
  assert.match(scoringLog, /Export Batch \(max \$\{MAX_SCORING_RUN_JOBS\}\)/);
  assert.match(scoringLog, /Each export reserves up to \{MAX_SCORING_RUN_JOBS\} jobs/);
  assert.match(scoringLog, /remaining jobs stay ready for the next batch/);
  assert.doesNotMatch(scoringLog, /Export Entire Queue|reserves the whole current queue/);
  assert.match(scoringLog, /SCORING_RUN_CHILD_BATCH_SIZE/);
  assert.match(scoringLog, /Import is atomic per/);
  assert.match(scoringLog, /Partially applied/);
  assert.match(scoringLog, /Blocked child/);
  assert.match(scoringLog, /Drop result JSON here/);
  assert.match(scoringLog, /onDrop=\{handleImportDrop\}/);
  assert.match(scoringLog, /Import .* scoring result JSON/);
  assert.doesNotMatch(scoringLog, /Preview Results|Export Aim Batch|Export Experience Batch/);
  assert.doesNotMatch(scoringLog, /Active Aim failure suppressions|Download one-job retry|\/api\/scoring\/failures/);
  assert.match(scoringLog, /send.*unscored job\(s\) to Action Needed/);
  assert.match(batch, /START-AIM-FIT-/);
  assert.match(batch, /START-E-FIT-/);
  assert.match(run, /START-AIM-FIT-RUN-/);
  assert.match(run, /START-E-FIT-RUN-/);
  assert.match(run, /SCORING_RUN_CHILD_BATCH_SIZE/);
  assert.match(run, /runOrdinal/);
  assert.doesNotMatch(runsRoute, /exportJson:\s*true/);
  assert.match(runsRoute, /blockedBatchCount/);
  assert.doesNotMatch(scoringLog, /career-dashboard-\$\{stage\}-export|career-dashboard-aim-retry/);
  assert.match(exporter, /limit > MANUAL_SCORING_BATCH_SIZE/);
  assert.match(exporter, /limit = MANUAL_SCORING_BATCH_SIZE/);
  assert.match(exporter, /operationalQueueWhere\('aim_fit', \[\]\)/);
  assert.match(exporter, /operationalQueueWhere\('experience_fit', \[\]\)/);
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
  assert.match(exporter, /prepareAim\(prisma, MAX_SCORING_RUN_JOBS\)/);
  assert.match(exporter, /prepareExperience\(prisma, MAX_SCORING_RUN_JOBS\)/);
  assert.match(exporter, /start \+= SCORING_RUN_CHILD_BATCH_SIZE/);
  assert.match(exporter, /createScoringRun\(prisma, \{ stage, batchInputs \}\)/);
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
