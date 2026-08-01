import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  NATIVE_SCORING_CHUNK_SIZE,
  parseContextResult,
  parseNativeScoringChunk,
} from '../src/lib/nativeScoringBatch';

const id = '11111111-1111-4111-8111-111111111111';
const submittedUpdatedAt = '2026-08-01T12:00:00.000Z';

const contextChunk = parseNativeScoringChunk({
  schemaVersion: 'native-scoring-batch-v6.2',
  batchId: 'native_canary_context',
  chunkId: 'chunk_0000',
  type: 'context',
  contextProfile: { rulesText: 'DO REJECT:\n- Retail sales', submittedUpdatedAt: null },
  jobs: [{
    id,
    title: 'Account Executive',
    company: 'Example',
    location: 'Remote',
    description: 'A normal job description.',
    passReason: 'Too much cold prospecting',
    submittedUpdatedAt,
  }],
});
assert.equal(contextChunk.type, 'context');
assert.equal(contextChunk.jobs.length <= NATIVE_SCORING_CHUNK_SIZE, true);

parseContextResult({
  contextUpdate: {
    submittedContextProfileUpdatedAt: null,
    updatedContextRules: 'DO REJECT:\n- Roles dominated by cold prospecting',
    processedFeedback: [{ id, submittedUpdatedAt }],
  },
}, [{ id, submittedUpdatedAt }], null);

assert.throws(() => parseContextResult({
  contextUpdate: {
    submittedContextProfileUpdatedAt: null,
    updatedContextRules: 'DO ACCEPT:\n- SaaS roles',
    processedFeedback: [{ id, submittedUpdatedAt }],
  },
}, [{ id, submittedUpdatedAt }], null), /DO REJECT/);

const hook = fs.readFileSync('scripts/antigravity_scoring_hook.mjs', 'utf8');
const runner = fs.readFileSync('.agents/agents/native-scoring-runner-v6/agent.md', 'utf8');
const watcher = fs.readFileSync('scripts/native_scoring_watcher.ts', 'utf8');
const installer = fs.readFileSync('scripts/install_native_scoring_watcher.ts', 'utf8');
const prepare = fs.readFileSync('scripts/prepare_native_scoring_phase.ts', 'utf8');
const release = fs.readFileSync('scripts/release_scoring_batch.ts', 'utf8');
const pipeline = fs.readFileSync('src/app/api/pipeline/run/route.ts', 'utf8');
const legacyRelease = fs.readFileSync('src/app/api/jobs/release/route.ts', 'utf8');
const migration = fs.readFileSync(
  'prisma/migrations/20260801210000_native_scoring_automation/migration.sql',
  'utf8',
);
const hooks = JSON.parse(fs.readFileSync('.agents/hooks.json', 'utf8')) as {
  'native-scoring-v6-boundary': { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
};
assert.match(hook, /subagents\.length > 2/);
assert.match(hook, /\{0,19\}/);
assert.doesNotMatch(`${hook}\n${watcher}`, /--dangerously-skip-permissions/);
assert.match(runner, /npm run --silent scoring:next -- --request <UUID>/);
assert.match(watcher, /shell: false/);
assert.match(watcher, /delete environment\[key\]/);
assert.match(watcher, /DEEPSEEK_API_KEY/);
assert.match(watcher, /GEMINI_API_KEY/);
assert.match(installer, /command\(npm run --silent scoring:request -- --source agy\)/);
assert.match(installer, /command\(npm run --silent scoring:next -- --request \[0-9a-f\]\{8\}-/);
assert.match(installer, /line\.trim\(\) === 'native-scoring-runner-v6'/);
assert.doesNotMatch(installer, /command\(\*\)/);
assert.match(prepare, /assertEvaluatorResumeMatches/);
assert.match(release, /idempotencyKey: \{ startsWith: `\$\{batchId\}:` \}/);
assert.match(pipeline, /afBatchId: \{ startsWith: 'native_' \}/);
assert.match(pipeline, /luckyBatchId: \{ startsWith: 'native_' \}/);
assert.doesNotMatch(legacyRelease, /prisma\.job\.updateMany/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "NativeScoringRequest_activeKey_key"/);
assert.match(migration, /ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "contextHash"/);
assert.equal(
  hooks['native-scoring-v6-boundary'].PreToolUse[0].hooks[0].command,
  'node ../scripts/antigravity_scoring_hook.mjs',
);

console.log('Native scoring structural canary passed.');
