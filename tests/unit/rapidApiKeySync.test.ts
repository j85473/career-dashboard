import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = path.resolve('scripts/deployment/rapidapi-key-env.mjs');
const syncScript = readFileSync(path.resolve('scripts/sync-rapidapi-keys.sh'), 'utf8');
const deployScript = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8');
const workflow = readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8');

test('normalization replaces the whole RapidAPI key family with one canonical list', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rapidapi-key-sync-'));
  try {
    const envPath = path.join(directory, '.env');
    writeFileSync(envPath, [
      'DATABASE_URL=postgresql://example.invalid/db',
      'RAPIDAPI_KEY=legacy-key-0001',
      'RAPIDAPI_KEY_2=legacy-key-0002',
      'RAPIDAPI_KEYS="canonical-key-0001,canonical-key-0002,canonical-key-0001"',
      'JINA_API_KEY=preserved-value',
      '',
    ].join('\n'), { mode: 0o600 });

    const result = spawnSync(process.execPath, [helper, 'normalize', envPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const fingerprint = JSON.parse(result.stdout) as { count: number; sha256: string };
    assert.equal(fingerprint.count, 2);
    assert.match(fingerprint.sha256, /^[a-f0-9]{64}$/);

    const normalized = readFileSync(envPath, 'utf8');
    assert.match(normalized, /^DATABASE_URL=/m);
    assert.match(normalized, /^JINA_API_KEY=/m);
    assert.match(normalized, /^RAPIDAPI_KEYS=canonical-key-0001,canonical-key-0002$/m);
    assert.doesNotMatch(normalized, /^RAPIDAPI_KEY(?:_[0-9]+)?=/m);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sync and deployment move secrets over stdin, replace legacy variables, and fail closed', () => {
  assert.match(syncScript, /gh secret set RAPIDAPI_KEYS < "\$secret_file"/);
  assert.match(syncScript, /ssh "\$REMOTE"[\s\S]*< "\$secret_file"/);
  assert.match(syncScript, /rapidapi-key-env\.mjs' apply \/etc\/career-dashboard\/runtime\.env/);
  assert.match(syncScript, /chown root:career-dashboard/);
  assert.match(syncScript, /local_fingerprint[\s\S]*pi_fingerprint/);
  assert.doesNotMatch(syncScript, /echo "\$RAPIDAPI_KEYS"/);

  assert.match(deployScript, /Deployment requires canonical RAPIDAPI_KEYS/);
  assert.match(deployScript, /rapidapi-key-env\.mjs canonicalize/);
  assert.match(deployScript, /grep -Ev '\^RAPIDAPI_KEY\(S\|_\[0-9\]\+\)\?='/);
  assert.doesNotMatch(deployScript, /Pi keeps whatever keys it already has/);
  assert.match(workflow, /RAPIDAPI_KEYS: \$\{\{ secrets\.RAPIDAPI_KEYS \}\}/);
});
