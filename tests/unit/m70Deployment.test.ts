import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const activation = readFileSync(path.resolve('scripts/deployment/activate-m70.sh'), 'utf8');
const entrypoint = readFileSync(path.resolve('scripts/deployment/deploy-m70.sh'), 'utf8');
const workflow = readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8');

test('a release is built from one clean commit and never against production credentials', () => {
  // The archive that reaches the M70 is the commit CI tested, not a working
  // tree: an uncommitted change cannot ride along, and the revision is pinned.
  assert.match(entrypoint, /REV=\$\(git rev-parse HEAD\)/);
  assert.match(entrypoint, /\[\[ \$REV =~ \^\[a-f0-9\]\{40\}\$ \]\]/);
  assert.match(entrypoint, /\[\[ -z \$\(git status --porcelain --untracked-files=no\) \]\]/);
  // The build must not be able to reach the real database even by accident.
  assert.match(activation, /npm run build/);
  const build = activation.slice(0, activation.indexOf('npm run build'));
  assert.match(build, /DATABASE_URL=postgresql:\/\/build:build@127\.0\.0\.1:1\/build/);
  assert.doesNotMatch(build, /prisma migrate deploy/);
});

test('a release proves quiescence and takes a recovery point before it touches the schema', () => {
  const stopAcquisition = activation.indexOf('systemctl stop career-dashboard-acquisition.service');
  const proven = activation.indexOf('(( QUIET == 1 ))');
  const backup = activation.indexOf('backup-postgres.mjs');
  const migrate = activation.indexOf('prisma migrate deploy');
  const swap = activation.indexOf('mv -Tf "$APP.next" "$APP"');
  assert.ok(stopAcquisition >= 0 && stopAcquisition < proven, 'workers stop before quiescence is judged');
  assert.ok(proven < backup, 'the recovery point is taken only once nothing is still writing');
  assert.ok(backup < migrate, 'a migration is never the first thing to touch the database');
  assert.ok(migrate < swap, 'the schema is migrated before the code that expects it serves traffic');
});

test('a failed release restores the previous code and never restores an old database', () => {
  const recover = activation.slice(activation.indexOf('recover() {'), activation.indexOf('trap recover ERR'));
  assert.match(recover, /preserving the database/);
  assert.match(recover, /mv -Tf "\$APP\.rollback" "\$APP"/);
  assert.match(recover, /acquisition-release\.env\.previous/);
  // Rollback is a routing change. Restoring a dump over newer user actions is
  // a deliberate operator decision, never an automatic consequence of a
  // failed deploy.
  assert.doesNotMatch(recover, /pg_restore|psql|backup-postgres/);
});

test('background services are restored only after the new release answers, and a maintenance deploy leaves them stopped', () => {
  const healthy = activation.indexOf('(( HEALTHY == 1 ))');
  const restart = activation.lastIndexOf('restart_background');
  assert.ok(healthy >= 0 && healthy < restart, 'health is proven before work resumes');
  assert.match(activation, /\[\[ \$MODE != maintenance \]\] \|\| \{ SCHEDULE=0; WATCHDOG=0; ACQUISITION=0; PRUNING=0; \}/);
  // Whatever was running before a deploy is what runs after it. A deploy is
  // not a way to start services an operator had deliberately stopped.
  assert.match(activation, /systemctl is-active --quiet career-dashboard-acquisition\.service && ACQUISITION=1/);
  assert.match(workflow, /ACTIVATION_MODE: \$\{\{ vars\.PI_ACTIVATION_MODE \|\| 'normal' \}\}/);
});

test('a release keeps user data, runtime state and credentials outside the code it swaps', () => {
  // Everything durable lives in the shared tree or the restricted config file,
  // so swapping the release symlink cannot take data with it.
  assert.match(activation, /ln -sfn \/etc\/career-dashboard\/runtime\.env "\$STAGE\/\.env"/);
  assert.match(activation, /rsync -a --ignore-existing --exclude=runtime\/ "\$SHARED\/data\/" "\$STAGE\/data\/"/);
  assert.match(activation, /ln -s "\$SHARED\/data\/runtime" "\$STAGE\/data\/runtime"/);
  assert.match(activation, /discover_progress\.json/);
  // Never the other way round: credentials must not be written into a release.
  assert.doesNotMatch(activation, /RAPIDAPI|SCORING_APPROVAL_SECRET|PIPELINE_SECRET/);
});

test('production activation requires a strong scoring approval secret', () => {
  const checker = path.resolve('scripts/deployment/require-env.mjs');
  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => name !== 'SCORING_APPROVAL_SECRET' && value !== undefined),
  ) as Record<string, string>;
  const run = (secret?: string) => spawnSync(process.execPath, [checker], {
    encoding: 'utf8',
    env: {
      ...baseEnvironment,
      DATABASE_URL: 'postgresql://test.invalid/test',
      PIPELINE_SECRET: 'test-pipeline-secret',
      ...(secret === undefined ? {} : { SCORING_APPROVAL_SECRET: secret }),
    } as unknown as NodeJS.ProcessEnv,
  });

  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SCORING_APPROVAL_SECRET/);

  const short = run('too-short');
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /at least 32 UTF-8 bytes/);

  const valid = run('x'.repeat(32));
  assert.equal(valid.status, 0, valid.stderr);
});

test('a deploy never invalidates scoring work', () => {
  // Shipping a refined policy is not a judgment that the scores produced under
  // the previous one were wrong, and re-scoring the backlog costs real manual
  // hours. Reconciliation is a reporting tool run deliberately, never a side
  // effect of pushing.
  const activation = readFileSync(path.resolve('scripts/deployment/activate-m70.sh'), 'utf8');
  assert.doesNotMatch(activation, /reconcile_scoring_input_versions/);
  assert.doesNotMatch(activation, /--invalidate-drifted/);
});

test('GitHub deployment forwards the bounded maintenance activation control', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8');
  const deployScript = readFileSync(path.resolve('scripts/deployment/deploy-m70.sh'), 'utf8');
  const runbook = readFileSync(path.resolve('docs/CAREER_DASHBOARD_REPAIR_RUNBOOK_2026-08-09.md'), 'utf8');
  assert.match(workflow, /ACTIVATION_MODE: \$\{\{ vars\.PI_ACTIVATION_MODE \|\| 'normal' \}\}/);
  assert.match(workflow, /ACTIVATION_MODE:[^\n]+[\s\S]*bash scripts\/deployment\/deploy-m70\.sh/);
  assert.match(deployScript, /ACTIVATION_MODE="\$\{ACTIVATION_MODE:-normal\}"/);
  assert.match(deployScript, /ACTIVATION_MODE must be 'normal' or 'maintenance'/);
  assert.match(runbook, /PI_ACTIVATION_MODE=maintenance/);
  assert.match(runbook, /Keep the variable set until that workflow[\s\S]*maintenance activation is verified/);
  assert.match(runbook, /restore or delete the[\s\S]*variable/);
  assert.match(runbook, /Do not enable[\s\S]*cron as part of that cleanup/);
});

test('strict repair readiness audits every worker and lease class before cron enable', () => {
  const readiness = readFileSync(path.resolve('scripts/audit_repair_readiness.ts'), 'utf8');
  const runbook = readFileSync(path.resolve('docs/CAREER_DASHBOARD_REPAIR_RUNBOOK_2026-08-09.md'), 'utf8');
  for (const field of [
    'activeRequests',
    'nonterminalRequests',
    'pipelineLocks',
    'runningPipelineStates',
    'activeLeases',
    'runningTasks',
    'localScoringLeases',
    'localScoringStates',
    'jdExtractionLeases',
    'nativeJobLeases',
    'contextJobLeases',
    'contextProfileBatchLeases',
    'contextProfileLinkedinLeases',
    'liveAtsBatchLeases',
    'staleAtsBatchLeases',
    'liveAtsAttemptLeases',
    'staleAtsAttemptLeases',
    'liveProviderRequestLeases',
    'staleProviderRequestLeases',
  ]) assert.match(readiness, new RegExp(field));
  for (const violation of [
    'active_native_scoring_requests',
    'active_pipeline_lock',
    'active_ingestion_leases',
    'active_scoring_leases',
    'active_ats_batch_leases',
    'stale_ats_batch_leases',
    'active_ats_attempt_leases',
    'stale_ats_attempt_leases',
    'active_provider_request_leases',
    'stale_provider_request_leases',
  ]) assert.match(readiness, new RegExp(violation));
  assert.match(readiness, /to_regclass\('"AtsIngestionBatch"'\) IS NOT NULL/);
  assert.match(readiness, /to_regclass\('"AtsBoardCheckAttempt"'\) IS NOT NULL/);
  for (const schemaContract of [
    'atsBatchRuntimeColumns',
    'atsAttemptRuntimeColumns',
    'atsCompanyRuntimeColumns',
    'providerRequestLeaseColumns',
  ]) assert.match(readiness, new RegExp(schemaContract));
  for (const requiredColumn of [
    'payloadHash',
    'processingAttemptCount',
    'processingOffset',
    'nextProcessAt',
    'leaseToken',
    'leaseOwner',
    'leaseExpiresAt',
    'lastAttemptedAt',
    'lastRespondedAt',
    'lastSynchronizedAt',
    'lastProcessedAt',
    'requestLeaseToken',
    'requestLeaseOwner',
    'requestLeaseExpiresAt',
  ]) assert.match(readiness, new RegExp(`\\('${requiredColumn}'\\)`));
  assert.match(readiness, /existing\.table_schema = current_schema\(\)/);
  assert.match(readiness, /schema\.atsIngestionBatch && schema\.atsBatchRuntimeColumns/);
  assert.match(readiness, /schema\.atsBoardCheckAttempt && schema\.atsAttemptRuntimeColumns/);
  assert.match(readiness, /CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS "utcNow"/);
  assert.match(runbook, /ACTIVATION_MODE=maintenance \.\/scripts\/deploy\.sh/);
  assert.match(runbook, /npm run --silent ingestion:seed-tasks/);
  assert.match(runbook, /seededTaskCount == expectedTaskCount/);
  assert.match(runbook, /providerRequests: 0/);
  assert.match(runbook, /leasesClaimed: 0/);
  assert.match(runbook, /node scripts\/with-env\.mjs npm run --silent ingestion:seed-tasks/);
  assert.match(runbook, /api\/pipeline\/local/);
  assert.match(runbook, /nativeReplayPreflight/);
  assert.match(runbook, /scoring:watch:once/);
  assert.match(runbook, /com\.josephlamb\.career-dashboard-native-scoring/);
  assert.doesNotMatch(runbook, /com\.josephlamb\.career-dashboard\.native-scoring/);
  assert.match(runbook, /strict readiness and cron enable in\s+one fail-closed Pi shell/);
  assert.match(readiness, /missingTaskKeys/);
  assert.match(readiness, /seededTaskCount/);
  assert.match(readiness, /legacyUnreconciledEvidence7d/);
  assert.match(readiness, /legacyCounterEquationGaps7d/);
  assert.match(readiness, /durableCounterMismatches7d/);
  assert.match(readiness, /durable_source_run_unreconciled/);
  assert.match(readiness, /checkpoint IS NOT NULL[\s\S]*reconciled = true/);
  assert.match(runbook, /Pre-migration rows[\s\S]*not reconstructed or treated as current invariant\s+failures/i);
});

test('a deployment quiesce leaves an operator pause alone so the deploy cannot restart the pipeline', () => {
  const stopRoute = readFileSync(path.resolve('src/app/api/pipeline/stop/route.ts'), 'utf8');
  const activation = readFileSync(path.resolve('scripts/deployment/activate-m70.sh'), 'utf8');
  const runRoute = readFileSync(path.resolve('src/app/api/pipeline/run/route.ts'), 'utf8');

  // The deploy stops the pipeline with the quiesce mode, and restarts the
  // scheduler timer afterwards. If the quiesce also cleared the pause, that
  // timer would find an enabled schedule and start a pipeline the operator had
  // deliberately stopped.
  assert.match(activation, /api\/pipeline\/stop\?mode=quiesce/);
  assert.match(activation, /systemctl start career-dashboard-scheduler\.timer/);

  // Quiesce contributes no schedule fields at all, so the existing
  // schedulePaused/pausedUntil survive the deploy untouched.
  assert.match(
    stopRoute,
    /const scheduleIntent = mode === 'quiesce' \? \{\} : \{ schedulePaused: pauseSchedule, pausedUntil \};/,
  );
  assert.match(stopRoute, /update: \{ isRunning: false, \.\.\.scheduleIntent, currentStep, stepProgress, lastUpdated: new Date\(\) \}/);
  // The update path must never write these directly again.
  const updateLine = stopRoute.slice(stopRoute.indexOf('update: { isRunning: false'), stopRoute.indexOf('create: { id:'));
  assert.doesNotMatch(updateLine, /schedulePaused:/);
  // A brand new row has no prior intent to preserve, so create still sets it.
  assert.match(stopRoute, /create: \{ id: 'global', isRunning: false, schedulePaused: pauseSchedule, pausedUntil,/);
  // An ordinary Stop still pauses the schedule.
  assert.match(stopRoute, /const pauseSchedule = mode !== 'quiesce';/);

  // The scheduler is what honours the preserved pause: a scheduled run demands
  // an enabled schedule, while a manual start is the deliberate resume.
  assert.match(runRoute, /requireScheduleEnabled: scheduledRequest/);
  assert.match(runRoute, /if \(!scheduledRequest\) \{[\s\S]*?update: \{ schedulePaused: false, pausedUntil: null \}/);
});

// The installer runs under `runuser`, which starts a fresh environment. When the
// nightly dump's destination was environment-only it silently fell back to the
// release directory -- the microSD card on the Pi -- while deployment backups
// went to the SSD. The passed directory has to beat both the environment and
// the fallback, or that regression comes back invisibly.
test('a release waits on running processes, not on Joseph', () => {
  const gate = readFileSync(path.resolve('scripts/deployment/quiescence-query.cjs'), 'utf8');

  // A manual scoring lease is held by a person working through an export on
  // their Desktop, not by a process the deployment is about to stop. Counting
  // it made a release wait on a human: on 2026-09-03 a deploy sat in the
  // quiescence loop with five leased batches and every other counter at zero,
  // looked hung, and was cancelled mid-flight.
  assert.match(gate, /gateMode === 'strict'\s*\n?\s*\?\s*await prisma\.\$queryRawUnsafe/);
  const scoring = gate.slice(gate.indexOf('const scoringRows'), gate.indexOf('const atsBatchRows'));
  assert.match(scoring, /schemaRows\[0\]\?\.scoringBatch && gateMode === 'strict'/);
  // Strict mode is unchanged: it still refuses to run beside any batch at all,
  // including one that is merely exported.
  assert.match(scoring, /b\.status IN \('exported', 'superseded'\)/);
  assert.match(scoring, /i\.status = 'leased'/);

  // What a release must still wait for is work a process is actually doing.
  for (const held of [
    '"PipelineState"',
    '"AtsAcquisitionWorkerSlot"',
    '"AtsIngestionBatch"',
    '"AtsBoardCheckAttempt"',
  ]) {
    assert.ok(gate.includes(held), `${held} must still gate a release`);
  }
  // And any non-zero counter still fails the gate; nothing is merely warned about.
  assert.match(gate, /Object\.values\(active\)\.some\(\(value\) => value !== 0\)/);
});
