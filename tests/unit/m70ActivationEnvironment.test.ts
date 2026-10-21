import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const activation = readFileSync('scripts/deployment/activate-m70.sh', 'utf8');

function preflight(alreadyBuilt: boolean, auditResult = 1, directoryPrefix = 'm70-activation-') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), directoryPrefix)));
  try {
    const revision = 'a'.repeat(40);
    const releases = path.join(root, 'releases');
    const stage = path.join(releases, revision);
    const shared = path.join(root, 'shared');
    const config = path.join(root, 'config');
    const caller = path.join(root, 'caller');
    for (const directory of [stage, `${stage}/scripts/deployment`, `${stage}/data`, `${shared}/data/runtime`, config, caller]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(`${stage}/package-lock.json`, '{}');
    writeFileSync(`${shared}/data/discover_logs.txt`, 'saved discovery log');
    writeFileSync(`${config}/production-enabled`, '');
    writeFileSync(`${config}/runtime.env`, 'DATABASE_URL=postgresql://production.invalid/career\n');
    writeFileSync(`${caller}/.env`, 'DATABASE_URL=postgresql://build:build@127.0.0.1:1/build\n');
    if (alreadyBuilt) writeFileSync(`${stage}/.m70-build-complete`, '');
    symlinkSync(stage, path.join(root, 'app'));
    symlinkSync(path.resolve('node_modules'), `${stage}/node_modules`, 'dir');
    writeFileSync(`${stage}/scripts/with-env.mjs`, readFileSync('scripts/with-env.mjs'));
    writeFileSync(`${stage}/scripts/deployment/discovery-audit-resume-needed.cjs`, `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(`${root}/probe.json`)}, JSON.stringify({
        cwd: fs.realpathSync(process.cwd()), database: process.env.DATABASE_URL,
      }));
      process.exit(${auditResult});
    `);

    // Run the real activation through its audit precheck, before any service
    // stop. Substitute only machine paths and privileged external operations.
    const prefix = activation.slice(0, activation.indexOf('[[ $MODE != maintenance ]]'))
      .replaceAll('/opt/career-dashboard-releases', '"$M70_TEST_RELEASES"')
      .replaceAll('/opt/career-dashboard', '"$M70_TEST_APP"')
      .replaceAll('/var/lib/career-dashboard', '"$M70_TEST_SHARED"')
      .replaceAll('/etc/career-dashboard', '"$M70_TEST_CONFIG"')
      .replace('export PATH=/usr/local/bin:', 'export PATH="$M70_TEST_NODE_DIR":/usr/local/bin:');
    const script = `
      id() { echo 0; }
      hostname() { echo m70; }
      flock() { :; }
      python3() { :; }
      chown() { :; }
      rsync() { :; }
      systemctl() { [[ $1 == is-active ]] && return 1; exit 99; }
      runuser() {
        shift 3
        if [[ $1 == env ]]; then
          printf '%s\\n' "$*" >> "$M70_TEST_ROOT/build-calls"
          return 0
        fi
        "$@"
      }
      ${prefix}
      echo "audit-resume=$DISCOVERY_AUDIT"
    `;
    const result = spawnSync('bash', ['-c', script, 'activation-test', revision], {
      cwd: caller, encoding: 'utf8', env: {
        PATH: process.env.PATH, NODE_ENV: 'test',
        M70_TEST_ROOT: root, M70_TEST_RELEASES: releases,
        M70_TEST_APP: path.join(root, 'app'), M70_TEST_SHARED: shared,
        M70_TEST_CONFIG: config, M70_TEST_NODE_DIR: path.dirname(process.execPath),
      },
    });
    assert.ok(existsSync(`${root}/probe.json`), `audit probe was not reached: ${result.stderr}`);
    assert.equal(existsSync(path.join(caller, 'm70-path-injection')), false);
    assert.equal(existsSync(path.join(stage, 'm70-path-injection')), false);
    return {
      ...result,
      expectedStage: realpathSync(stage),
      probe: JSON.parse(readFileSync(`${root}/probe.json`, 'utf8')) as { cwd: string; database: string },
      buildCalls: alreadyBuilt ? [] : readFileSync(`${root}/build-calls`, 'utf8').trim().split('\n'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const alreadyBuilt of [false, true]) {
  test(`${alreadyBuilt ? 'repeat' : 'fresh'} activation loads production settings before the audit precheck`, () => {
    const result = preflight(alreadyBuilt, alreadyBuilt ? 1 : 0);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.probe.cwd, result.expectedStage);
    assert.equal(result.probe.database, 'postgresql://production.invalid/career');
    assert.match(result.stdout, new RegExp(`audit-resume=${alreadyBuilt ? 0 : 1}`));
    assert.equal(result.buildCalls.length, alreadyBuilt ? 0 : 3);
    for (const command of result.buildCalls) {
      assert.match(command, /DATABASE_URL=postgresql:\/\/build:build@127\.0\.0\.1:1\/build/);
    }
  });
}

test('activation fixture treats spaces, quotes, and shell substitutions in paths as literal data', () => {
  const result = preflight(false, 0, 'm70 activation "$HOME" $(touch m70-path-injection) ');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.probe.cwd, result.expectedStage);
  assert.equal(result.probe.database, 'postgresql://production.invalid/career');
  assert.equal(result.buildCalls.length, 3);
});

test('an uncertain audit precheck still aborts a repeat activation before touching services', () => {
  const result = preflight(true, 2);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Could not establish discovery-audit recovery state/);
  assert.doesNotMatch(result.stdout, /audit-resume=/);
});
