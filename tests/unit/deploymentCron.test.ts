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
  mkdirSync(binDirectory, { recursive: true });

  writeFileSync(path.join(appDirectory, '.env'), 'PIPELINE_SECRET=test\n');
  writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({
    scripts: {
      'cron:discovery': 'true',
      'cron:pipeline': 'true',
      'cron:linkedin': 'true',
      'cron:reconcile': 'true',
    },
  }));

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

function runInstaller(fixture: Fixture, extraEnvironment: Record<string, string | undefined> = {}) {
  return spawnSync('bash', [installerPath, fixture.appDirectory, 'http://127.0.0.1:3000'], {
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
  assert.equal((installed.match(/ run cron:/g) || []).length, 4);
  assert.equal((installed.match(/DASHBOARD_URL=http:\/\/127\.0\.0\.1:3000/g) || []).length, 4);

  const secondRun = runInstaller(fixture);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.equal(readFileSync(fixture.crontabState, 'utf8'), installed);
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

test('deploy script uses interactive sudo helpers instead of a privileged heredoc', () => {
  const deployScript = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8');
  const activationScript = readFileSync(path.resolve('scripts/deployment/activate-release.sh'), 'utf8');
  assert.match(deployScript, /ssh -tt "\$REMOTE"/);
  assert.match(deployScript, /sudo -- bash .*activate-release\.sh/);
  assert.match(deployScript, /HEALTHCHECK_URL_OVERRIDE/);
  assert.doesNotMatch(deployScript, /<<'ACTIVATE_SCRIPT'/);
  assert.match(activationScript, /resolve_service_base_url "\$SERVICE_NAME"/);
  assert.match(activationScript, /Activation health check target: \$HEALTHCHECK_URL/);
  assert.match(activationScript, /curl --fail-with-body --silent --show-error/);
  assert.match(activationScript, /"\$CRONTAB_BIN" -u "\$APP_USER" -l/);
  assert.doesNotMatch(activationScript, /chown "\$APP_USER" "\$CRON_BACKUP_FILE"/);
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
    ['-c', 'source "$1"; resolve_service_base_url career-dashboard ""', 'bash', serviceUrlHelperPath],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH || ''}` },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'http://100.80.154.113:3000');
});
