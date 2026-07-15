import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('pipeline lock heartbeats and release cannot delete a replacement lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-pipeline-state-'));
  const stateFile = path.join(directory, 'state.json');
  process.env.PIPELINE_STATE_FILE = stateFile;
  const state = await import('../../src/lib/pipelineState');

  const release = state.tryAcquirePipelineLock();
  assert.ok(release);
  state.updatePipelineState({ isRunning: true, currentStep: 'Test', stepProgress: 'Heartbeat' });
  assert.equal(state.readPipelineState().stepProgress, 'Heartbeat');

  const lockFile = `${stateFile}.lock`;
  state.updatePipelineState({ isRunning: false, currentStep: 'Idle', stepProgress: 'Stale' });
  const oldDate = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(lockFile, oldDate, oldDate);
  const releaseReplacement = state.tryAcquirePipelineLock();
  assert.ok(releaseReplacement);
  release();
  assert.equal(fs.existsSync(lockFile), true);
  releaseReplacement();
  assert.equal(fs.existsSync(lockFile), false);

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.PIPELINE_STATE_FILE;
});
