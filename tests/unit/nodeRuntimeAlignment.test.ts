import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const validator = path.resolve('scripts/deployment/require-node-version.sh');

function fakeNode(root: string, version: string) {
  const binDirectory = path.join(root, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  const nodePath = path.join(binDirectory, 'node');
  writeFileSync(nodePath, `#!/usr/bin/env bash\nprintf '%s\\n' '${version}'\n`);
  chmodSync(nodePath, 0o755);
  return nodePath;
}

test('repository declares one Node 24 runtime for developers, CI, packages, and Pi deployment', () => {
  const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
  const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { engines?: { node?: string } };
  const deployScript = readFileSync('scripts/deploy.sh', 'utf8');
  const cronInstaller = readFileSync('scripts/deployment/install-crontab-remote.sh', 'utf8');

  assert.equal(nvmrc, '24');
  assert.equal(packageJson.engines?.node, '>=24.0.0 <25.0.0');
  assert.match(workflow, /uses: actions\/checkout@v6/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.match(workflow, /node-version-file: '\.nvmrc'/);
  assert.doesNotMatch(workflow, /^\s*node-version:/m);

  const localCheck = deployScript.indexOf('require-node-version.sh "$PROJECT_ROOT"');
  const localNodeUse = deployScript.indexOf('rapidapi-key-env.mjs export');
  const piCheck = deployScript.indexOf('require-node-version.sh "$STAGE_DIR"');
  const dependencyFingerprint = deployScript.indexOf('CURRENT_FINGERPRINT=');
  assert.ok(localCheck >= 0 && localCheck < localNodeUse, 'local Node must be checked before deployment Node commands');
  assert.ok(piCheck >= 0 && piCheck < dependencyFingerprint, 'Pi Node must be checked before dependency reuse or install');
  assert.match(cronInstaller, /require-node-version\.sh" "\$DEST_DIR" "\$NODE_BIN"/);
});

test('Node runtime validator accepts the declared major and rejects drift', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-dashboard-node-runtime-'));
  try {
    writeFileSync(path.join(root, '.nvmrc'), '24\n');
    const matchingNode = fakeNode(root, 'v24.19.0');
    const matching = spawnSync('bash', [validator, root, matchingNode], { encoding: 'utf8' });
    assert.equal(matching.status, 0, matching.stderr);
    assert.match(matching.stdout, /Node runtime aligned: v24\.19\.0/);

    const driftedNode = fakeNode(root, 'v20.20.2');
    const drifted = spawnSync('bash', [validator, root, driftedNode], { encoding: 'utf8' });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /requires Node 24/);
    assert.match(drifted.stderr, /reports v20\.20\.2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node runtime validator fails closed for a malformed canonical version', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-dashboard-node-runtime-'));
  try {
    writeFileSync(path.join(root, '.nvmrc'), 'lts/*\n');
    const nodePath = fakeNode(root, 'v24.19.0');
    const result = spawnSync('bash', [validator, root, nodePath], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must contain a numeric Node version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
