import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  NATIVE_SCORING_CHUNK_SIZE,
  NATIVE_SCORING_EXPECTED_MODEL,
  NATIVE_SCORING_MANAGER_WAVE_SIZE,
  NATIVE_SCORING_SCHEMA_VERSION,
  NATIVE_SCORING_STANDARD_BATCH_SIZE,
  parseContextResult,
  parseNativeScoringChunk,
} from '../src/lib/nativeScoringBatch';

const id = '11111111-1111-4111-8111-111111111111';
const submittedUpdatedAt = '2026-08-01T12:00:00.000Z';
assert.equal(NATIVE_SCORING_STANDARD_BATCH_SIZE, NATIVE_SCORING_CHUNK_SIZE * 20);
assert.equal(NATIVE_SCORING_MANAGER_WAVE_SIZE, 4);
assert.equal(NATIVE_SCORING_MANAGER_WAVE_SIZE * NATIVE_SCORING_CHUNK_SIZE, 20);

const contextChunk = parseNativeScoringChunk({
  schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
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
const manager = fs.readFileSync('.agents/agents/scoring-manager-v6/agent.md', 'utf8');
const contextEvaluator = fs.readFileSync('.agents/agents/context-job-evaluator-v6/agent.md', 'utf8');
const standardEvaluator = fs.readFileSync('.agents/agents/standard-job-evaluator-v6/agent.md', 'utf8');
const watcher = fs.readFileSync('scripts/native_scoring_watcher.ts', 'utf8');
const installer = fs.readFileSync('scripts/install_native_scoring_watcher.ts', 'utf8');
const prepare = fs.readFileSync('scripts/prepare_native_scoring_phase.ts', 'utf8');
const directImport = fs.readFileSync('scripts/direct_import.ts', 'utf8');
const cooldownRecovery = fs.readFileSync('src/lib/cooldownRecovery.ts', 'utf8');
const jobCard = fs.readFileSync('src/components/JobCard.tsx', 'utf8');
assert.match(
  prepare,
  /contextBatchId: \{ not: null \}/,
  'context normalization must only inspect rows with an active context lease',
);
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
assert.match(hook, /`write_file\(\$\{target\}\)`/);
assert.doesNotMatch(`${hook}\n${watcher}`, /--dangerously-skip-permissions/);
assert.match(runner, /npm run --silent scoring:next -- --request <UUID>/);
assert.match(fs.readFileSync('scripts/native_scoring_next.ts', 'utf8'), /missing\.slice\(0, NATIVE_SCORING_MANAGER_WAVE_SIZE\)/);
for (const agent of [runner, manager, contextEvaluator, standardEvaluator]) {
  assert.match(agent, /^model: inherit$/m);
}
assert.match(watcher, /'--model', NATIVE_SCORING_EXPECTED_MODEL/);
assert.match(watcher, /'--effort', 'high'/);
assert.match(watcher, /shell: false/);
assert.match(watcher, /path\.dirname\(process\.execPath\)/);
assert.match(watcher, /node_modules', '\.bin'/);
assert.match(watcher, /delete environment\[key\]/);
assert.match(watcher, /DEEPSEEK_API_KEY/);
assert.match(watcher, /GEMINI_API_KEY/);
assert.match(installer, /command\(npm run --silent scoring:request\)/);
assert.match(installer, /command\(npm run --silent scoring:next\)/);
assert.match(installer, /write_file\(\$\{path\.join\(projectRoot, '\.agents', 'eval_runs'\)\}\)/);
assert.match(installer, /line\.trim\(\) === 'native-scoring-runner-v6'/);
assert.match(installer, /antigravity-cli', 'settings\.json'/);
assert.match(installer, /mergeAgyCliPermissions/);
assert.doesNotMatch(installer, /command\(\*\)/);
assert.doesNotMatch(installer, /write_file\(\*\)/);
assert.match(prepare, /assertEvaluatorResumeMatches/);
assert.match(prepare, /RECENT_DISMISSED_RECOVERY_LIMIT/);
assert.match(prepare, /requeueForStandardScoring\(tx\)/);
assert.match(prepare, /take: NATIVE_SCORING_STANDARD_BATCH_SIZE/);
assert.match(prepare, /const refreshCandidates = await prisma\.job\.findMany/);
assert.match(prepare, /const pendingCandidates = pendingCapacity <= 0/);
assert.match(prepare, /const legacyInboxCandidates = legacyCapacity <= 0/);
assert.match(prepare, /experienceStatus: 'rescore_queued'/);
assert.match(prepare, /const staleInboxRefreshData = \{/);
assert.match(directImport, /const holdsRefreshLease = job\.status === 'inbox'/);
assert.match(prepare, /prisma\.\$transaction/);
assert.match(prepare, /priorRecoveryCampaignScore/);
assert.match(prepare, /Joseph_Lamb_Channel_Sales_Resume_v3\.docx/);
assert.match(prepare, /\{ passReason: null \}/);
assert.match(standardEvaluator, /Immutable Standard Evaluator V6\.7\.1/);
assert.match(standardEvaluator, /first character must be `\{` and its final character must be `\}`/);
assert.match(manager, /exact single-fence transport case/);
assert.match(manager, /never leave a twice-failed chunk absent/);
assert.match(standardEvaluator, /Frozen channel-sales resume interpretation/);
assert.match(standardEvaluator, /Ordinary prospecting, pipeline development, or net-new responsibility inside a balanced territory\/account role/);
assert.match(standardEvaluator, /"id": "DSI-019"/);
assert.match(standardEvaluator, /`compensation` \(string or null\)/);
assert.match(standardEvaluator, /Compensation is informational and must not change Aim or Experience scoring/);
assert.match(directImport, /compensation: evaluation\.score\.compensation/);
assert.match(directImport, /const priorityOverride = isPromptHealthPriorityRole\(job\)/);
assert.match(directImport, /const passed = priorityOverride \|\| passesStandardScoring/);
assert.match(directImport, /fitCategory: 'promoted', cooldownUntil: null/);
assert.match(cooldownRecovery, /if \(isPromptHealthPriorityRole\(job\)\) continue/);
assert.match(jobCard, /prompt-health-priority-banner/);
assert.match(jobCard, /PROMPT_HEALTH_PRIORITY_BANNER/);
assert.match(fs.readFileSync('src/app/api/jobs/route.ts', 'utf8'), /compensation: true/);
assert.match(fs.readFileSync('src/app/api/jobs/search/route.ts', 'utf8'), /compensation: true/);
assert.match(
  fs.readFileSync('src/components/ExpandOverlay.tsx', 'utf8'),
  /\{job\.compensation\}[\s\S]*Via \{job\.source\}/,
);
assert.equal(fs.existsSync('scripts/requeue_rejected_jobs.ts'), false);
assert.match(release, /idempotencyKey: \{ startsWith: `\$\{batchId\}:` \}/);
assert.match(pipeline, /afBatchId: \{ startsWith: 'native_' \}/);
assert.doesNotMatch(legacyRelease, /prisma\.job\.updateMany/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "NativeScoringRequest_activeKey_key"/);
assert.match(migration, /ALTER TABLE "JobScoreEvent" ADD COLUMN IF NOT EXISTS "contextHash"/);
assert.equal(
  hooks['native-scoring-v6-boundary'].PreToolUse[0].hooks[0].command,
  'node ../scripts/antigravity_scoring_hook.mjs',
);

console.log('Native scoring structural canary passed.');
