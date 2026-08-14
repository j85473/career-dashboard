import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

const temporaryRoots: string[] = [];
const installerPath = path.resolve('scripts/deployment/install-crontab-remote.sh');
const serviceUrlHelperPath = path.resolve('scripts/deployment/service-url.sh');

type Fixture = {
  appDirectory: string;
  binDirectory: string;
  crontabState: string;
  root: string;
};

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function createFixture(initialCrontab: string | null): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'career-dashboard-cron-'));
  const appDirectory = path.join(root, 'app');
  const binDirectory = path.join(root, 'bin');
  const crontabState = path.join(root, 'crontab');
  temporaryRoots.push(root);
  mkdirSync(path.join(appDirectory, 'data', 'runtime'), { recursive: true });
  mkdirSync(path.join(appDirectory, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });

  writeFileSync(path.join(appDirectory, '.env'), 'PIPELINE_SECRET=test\n');
  writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({
    scripts: {
      'cron:discovery': 'true',
      'cron:pipeline': 'true',
      'cron:linkedin': 'true',
      'cron:reconcile': 'true',
    },
    dependencies: { tsx: '^4.22.4' },
  }));
  writeExecutable(path.join(appDirectory, 'node_modules', '.bin', 'tsx'), '#!/usr/bin/env bash\nexit 0\n');

  if (initialCrontab !== null) writeFileSync(crontabState, initialCrontab);

  writeExecutable(path.join(binDirectory, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(binDirectory, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(binDirectory, 'crontab'), `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_CRONTAB_STATE:?}"
installed_marker="\${state}.installed"
case "\${1:-}" in
  -l)
    if [[ ! -f "$state" ]]; then
      echo "no crontab for test" >&2
      exit 1
    fi
    cat "$state"
    if [[ "\${FAKE_CRONTAB_CORRUPT_READBACK:-}" == "1" && -f "$installed_marker" ]]; then
      echo "# corrupted readback"
    fi
    ;;
  -r)
    rm -f "$state" "$installed_marker"
    ;;
  *)
    cp "$1" "$state"
    touch "$installed_marker"
    ;;
esac
`);

  return { appDirectory, binDirectory, crontabState, root };
}

function runInstaller(
  fixture: Fixture,
  extraEnvironment: Record<string, string | undefined> = {},
  mode: 'enable' | 'disable' = 'enable',
) {
  return spawnSync('bash', [installerPath, fixture.appDirectory, 'http://127.0.0.1:3000', 'career-dashboard', mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnvironment,
      FAKE_CRONTAB_STATE: fixture.crontabState,
      PATH: `${fixture.binDirectory}:${process.env.PATH || ''}`,
    },
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cron installer replaces all legacy jobs, preserves unrelated entries, and is idempotent', () => {
  const legacyScripts = [
    '00_00_context.ts',
    '00_30_discovery.ts',
    '01_00_ingest.ts',
    '01_30_needs_jd.ts',
    '02_30_score.ts',
    '03_30_af.ts',
    '04_30_linkedin.ts',
    '05_30_ef.ts',
    'reconcile_jobs.ts',
  ];
  const initial = [
    'MAILTO=owner@example.com',
    '# --- CAREER DASHBOARD PIPELINE ---',
    ...legacyScripts.map((script, index) => `${index} ${index} * * * cd /opt/career-dashboard && npx tsx scripts/cron/${script}`),
    '# ---------------------------------',
    '17 9 * * * /usr/bin/example-task',
    '',
  ].join('\n');
  const fixture = createFixture(initial);

  const firstRun = runInstaller(fixture);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const installed = readFileSync(fixture.crontabState, 'utf8');
  assert.match(installed, /MAILTO=owner@example\.com/);
  assert.match(installed, /17 9 \* \* \* \/usr\/bin\/example-task/);
  for (const script of legacyScripts) assert.doesNotMatch(installed, new RegExp(script.replace('.', '\\.')));
  assert.equal((installed.match(/^# BEGIN CAREER DASHBOARD$/gm) || []).length, 1);
  assert.equal((installed.match(/^# END CAREER DASHBOARD$/gm) || []).length, 1);
  assert.equal((installed.match(/ run cron:/g) || []).length, 1);
  assert.equal((installed.match(/DASHBOARD_URL=http:\/\/127\.0\.0\.1:3000/g) || []).length, 1);

  const secondRun = runInstaller(fixture);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), installed);
});

test('maintenance mode removes only Career Dashboard triggers and is idempotent', () => {
  const initial = [
    'MAILTO=owner@example.com',
    '# BEGIN CAREER DASHBOARD',
    '* * * * * cd /opt/career-dashboard && npm run cron:pipeline',
    '# END CAREER DASHBOARD',
    '17 9 * * * /usr/bin/example-task',
    '',
  ].join('\n');
  const fixture = createFixture(initial);

  const firstRun = runInstaller(fixture, {}, 'disable');
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.match(firstRun.stdout, /cron schedule disabled and verified/i);
  const disabled = readFileSync(fixture.crontabState, 'utf8');
  assert.match(disabled, /MAILTO=owner@example\.com/);
  assert.match(disabled, /17 9 \* \* \* \/usr\/bin\/example-task/);
  assert.doesNotMatch(disabled, /CAREER DASHBOARD|cron:pipeline/);

  const secondRun = runInstaller(fixture, {}, 'disable');
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), disabled);
});

test('cron installer rejects unbalanced managed markers without changing crontab', () => {
  const initial = '# BEGIN CAREER DASHBOARD\n17 9 * * * /usr/bin/example-task\n';
  const fixture = createFixture(initial);

  const result = runInstaller(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unbalanced Career Dashboard cron markers/);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), initial);
});

test('cron installer validates all package scripts before changing crontab', () => {
  const initial = '17 9 * * * /usr/bin/example-task\n';
  const fixture = createFixture(initial);
  writeFileSync(path.join(fixture.appDirectory, 'package.json'), JSON.stringify({
    scripts: { 'cron:discovery': 'true' },
  }));

  const result = runInstaller(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required package scripts/);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), initial);
});

test('cron installer rejects a scheduler runtime that is available only as a development dependency', () => {
  const initial = '17 9 * * * /usr/bin/example-task\n';
  const fixture = createFixture(initial);
  writeFileSync(path.join(fixture.appDirectory, 'package.json'), JSON.stringify({
    scripts: { 'cron:pipeline': 'tsx scripts/cron/run_pipeline.ts' },
    devDependencies: { tsx: '^4.22.4' },
  }));

  const result = runInstaller(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tsx must be a production dependency/);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), initial);
});

test('cron installer rejects a missing installed scheduler runtime', () => {
  const initial = '17 9 * * * /usr/bin/example-task\n';
  const fixture = createFixture(initial);
  rmSync(path.join(fixture.appDirectory, 'node_modules', '.bin', 'tsx'));

  const result = runInstaller(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing production cron runtime/);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), initial);
});

test('the deployed dependency set includes the TypeScript cron runtime', () => {
  const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(readFileSync(path.resolve('package-lock.json'), 'utf8')) as {
    packages?: Record<string, { dependencies?: Record<string, string>; dev?: boolean }>;
  };

  assert.equal(typeof packageJson.dependencies?.tsx, 'string');
  assert.equal(packageJson.devDependencies?.tsx, undefined);
  assert.equal(typeof packageLock.packages?.['']?.dependencies?.tsx, 'string');
  assert.notEqual(packageLock.packages?.['node_modules/tsx']?.dev, true);
  assert.notEqual(packageLock.packages?.['node_modules/esbuild']?.dev, true);
});

test('cron installer restores the original crontab when readback verification fails', () => {
  const initial = '17 9 * * * /usr/bin/example-task\n';
  const fixture = createFixture(initial);

  const result = runInstaller(fixture, { FAKE_CRONTAB_CORRUPT_READBACK: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoring the previous crontab/);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), initial);
});

test('cron installer restores an absent original crontab when verification fails', () => {
  const fixture = createFixture(null);

  const result = runInstaller(fixture, { FAKE_CRONTAB_CORRUPT_READBACK: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(fixture.crontabState), false);
});

test('deploy script stages one clean Git commit and builds it on the Pi before database mutation', () => {
  const deployScript = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8');

  const dirtyTreeGate = deployScript.indexOf('status --porcelain=v1 --untracked-files=all');
  const stagingStart = deployScript.indexOf('Staging clean Git release');
  const npmInstall = deployScript.indexOf('\nnpm ci\n');
  const prismaGenerate = deployScript.indexOf('"$PRISMA_BIN" generate');
  const piBuild = deployScript.indexOf('npm run build');
  const backup = deployScript.indexOf('backup-postgres.mjs');
  const migrationDeploy = deployScript.indexOf('"$PRISMA_BIN" migrate deploy');
  const activation = deployScript.indexOf('Activating staged release');

  assert.ok(dirtyTreeGate >= 0 && dirtyTreeGate < stagingStart, 'dirty and untracked files must block before staging');
  assert.match(deployScript, /DEPLOY_COMMIT=.*rev-parse --verify HEAD/);
  assert.match(deployScript, /rsync -az --from0[\s\S]*--files-from=<\(git -c core\.fsmonitor=false ls-files -z\)/);
  assert.doesNotMatch(deployScript, /rsync -az --delete/);
  assert.match(deployScript, /api\/pipeline\/stop\?mode=quiesce/);
  assert.match(deployScript, /Release stage already exists/);
  assert.match(deployScript, /\nnpm ci\n/);
  assert.doesNotMatch(deployScript, /npm ci --omit=dev/);
  assert.match(deployScript, /PRISMA_BIN="\$STAGE_DIR\/node_modules\/\.bin\/prisma"/);
  assert.doesNotMatch(deployScript, /\bnpx\s+prisma\b/);
  assert.ok(
    npmInstall >= 0
      && npmInstall < prismaGenerate
      && prismaGenerate < piBuild
      && piBuild < backup
      && backup < migrationDeploy
      && migrationDeploy < activation,
    'pinned install, generate, Pi build, backup, migration, and activation must remain in exact order',
  );
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

test('maintenance deploy proves quiescence, stops the service, and gates again before migration', () => {
  const deployScript = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8');

  const maintenanceDisable = deployScript.indexOf('Disabling the production pipeline cron before backup, migration, and activation');
  const firstQuiescence = deployScript.indexOf('Verifying maintenance quiescence before stopping the production service');
  const serviceStop = deployScript.indexOf('Stopping $SERVICE_NAME so no new application work can race the migration');
  const piBuild = deployScript.indexOf('npm run build');
  const secondQuiescence = deployScript.indexOf('Re-verifying maintenance quiescence after the service stop and Pi build');
  const backup = deployScript.indexOf('backup-postgres.mjs');
  const migrationDeploy = deployScript.indexOf('"$PRISMA_BIN" migrate deploy');

  assert.ok(
    maintenanceDisable >= 0
      && maintenanceDisable < firstQuiescence
      && firstQuiescence < serviceStop
      && serviceStop < piBuild
      && piBuild < secondQuiescence
      && secondQuiescence < backup
      && backup < migrationDeploy,
    'maintenance disable, two quiescence gates, service stop, build, backup, and migration must remain ordered',
  );
  assert.equal((deployScript.match(/run_remote_quiescence_gate "\$DEST_DIR" "\$DEST_DIR" strict/g) || []).length, 1);
  assert.equal((deployScript.match(/run_remote_quiescence_gate "\$STAGE_DIR" "\$DEST_DIR" strict/g) || []).length, 1);
  for (const field of [
    '"isRunning" = true OR "lockToken" IS NOT NULL',
    'b.status IN (\'exported\', \'superseded\')',
    'i.status = \'leased\'',
    '"batchJobId" IS NOT NULL',
    '"jdBatchId" IS NOT NULL',
    '"afBatchId" IS NOT NULL',
    '"contextBatchId" IS NOT NULL',
    '"leaseToken" IS NOT NULL OR status = \'running\'',
  ]) assert.ok(deployScript.includes(field), `missing quiescence condition: ${field}`);
  assert.match(deployScript, /flock[\s\S]*schedule\.lock/);
  assert.match(deployScript, /sudo(?: -S)? -- systemctl stop '\$SERVICE_NAME'/);
  assert.match(deployScript, /Restarting the prior application release with its pipeline cron still disabled/);
});

test('normal deploy disables cron, requests stop, and proves runtime quiescence before activation', () => {
  const deployScript = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8');
  const migrationDeploy = deployScript.indexOf('"$PRISMA_BIN" migrate deploy');
  const normalDisable = deployScript.indexOf('Disabling the production pipeline cron before normal activation');
  const stopRequest = deployScript.indexOf('Requesting a clean stop from the production pipeline owner');
  const quiescenceWait = deployScript.indexOf('Waiting for runtime leases and process locks to quiesce before activation');
  const activation = deployScript.indexOf('Activating staged release');

  assert.ok(
    migrationDeploy >= 0
      && migrationDeploy < normalDisable
      && normalDisable < stopRequest
      && stopRequest < quiescenceWait
      && quiescenceWait < activation,
    'normal deployment must build and migrate before its bounded stop/quiescence activation gate',
  );
  assert.match(deployScript, /curl[\s\S]*-X POST "\$BASE_URL\/api\/pipeline\/stop\?mode=quiesce"/);
  assert.match(deployScript, /run_remote_quiescence_gate "\$app_dir" "\$schedule_dir" runtime/);
  assert.match(deployScript, /NORMAL_CRON_DISABLED=true/);
  assert.match(deployScript, /Restoring the prior release's Career Dashboard cron after the failed normal deployment/);
  assert.match(deployScript, /DEPLOY_QUIESCENCE_TIMEOUT_SECONDS/);
});

test('deploy script uses interactive sudo helpers instead of a privileged heredoc', () => {
  const deployScript = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8');
  const activationScript = readFileSync(path.resolve('scripts/deployment/activate-release.sh'), 'utf8');
  assert.match(deployScript, /ssh -tt "\$REMOTE"/);
  assert.match(deployScript, /sudo -- bash .*activate-release\.sh/);
  assert.match(deployScript, /HEALTHCHECK_URL_OVERRIDE/);
  assert.match(deployScript, /ACTIVATION_MODE/);
  const maintenanceDisable = deployScript.indexOf('Disabling the production pipeline cron before backup, migration, and activation');
  const migrationDeploy = deployScript.indexOf('"$PRISMA_BIN" migrate deploy');
  assert.ok(maintenanceDisable >= 0 && maintenanceDisable < migrationDeploy, 'maintenance cron must be disabled before migrations');
  assert.match(deployScript, /install-crontab-remote\.sh' '\$DEST_DIR' '' '\$SERVICE_NAME' disable/);
  assert.doesNotMatch(deployScript, /<<'ACTIVATE_SCRIPT'/);
  assert.match(activationScript, /resolve_service_base_url "\$SERVICE_NAME"/);
  assert.match(activationScript, /Activation health check target: \$HEALTHCHECK_URL/);
  assert.match(activationScript, /curl --fail-with-body --silent --show-error/);
  assert.match(activationScript, /"\$CRONTAB_BIN" -u "\$APP_USER" -l/);
  assert.match(activationScript, /ACTIVATION_MODE.*maintenance/);
  assert.match(activationScript, /install-crontab-remote\.sh[\s\S]*disable/);
  assert.match(activationScript, /Post-audit enable command/);
  assert.doesNotMatch(activationScript, /chown "\$APP_USER" "\$CRON_BACKUP_FILE"/);
});

test('GitHub deployment forwards the bounded maintenance activation control', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8');
  const deployScript = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8');
  const runbook = readFileSync(path.resolve('docs/CAREER_DASHBOARD_REPAIR_RUNBOOK_2026-08-09.md'), 'utf8');
  assert.match(workflow, /ACTIVATION_MODE: \$\{\{ vars\.PI_ACTIVATION_MODE \|\| 'normal' \}\}/);
  assert.match(workflow, /ACTIVATION_MODE:[^\n]+[\s\S]*run: bash scripts\/deploy\.sh/);
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
  ]) assert.match(readiness, new RegExp(field));
  for (const violation of [
    'active_native_scoring_requests',
    'active_pipeline_lock',
    'active_ingestion_leases',
    'active_scoring_leases',
  ]) assert.match(readiness, new RegExp(violation));
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

test('service URL resolver follows the systemd host and port used on the Pi', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-dashboard-service-url-'));
  const binDirectory = path.join(root, 'bin');
  temporaryRoots.push(root);
  mkdirSync(binDirectory, { recursive: true });
  writeExecutable(path.join(binDirectory, 'systemctl'), `#!/usr/bin/env bash
printf '%s\n' '{ path=/usr/bin/npm ; argv[]=/usr/bin/npm run start -- -H 100.80.154.113 -p 3000 ; }'
`);

  const result = spawnSync(
    'bash',
    [serviceUrlHelperPath, 'career-dashboard', ''],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH || ''}` },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'http://100.80.154.113:3000');
});
