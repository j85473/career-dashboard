import assert from 'node:assert/strict';
import test from 'node:test';

import { signalChildProcessGroup } from '../childProcessControl';

test('Unix scraper termination targets the detached process group', () => {
  const groupSignals: Array<[number, NodeJS.Signals]> = [];
  let directSignals = 0;
  const result = signalChildProcessGroup(
    { pid: 4242, kill: () => { directSignals++; return true; } },
    'SIGTERM',
    'linux',
    (pid, signal) => { groupSignals.push([pid, signal]); },
  );
  assert.equal(result, true);
  assert.deepEqual(groupSignals, [[-4242, 'SIGTERM']]);
  assert.equal(directSignals, 0);
});

test('Windows scraper termination uses the exact child handle', () => {
  const directSignals: NodeJS.Signals[] = [];
  const result = signalChildProcessGroup(
    { pid: 4242, kill: (signal) => { directSignals.push(signal as NodeJS.Signals); return true; } },
    'SIGKILL',
    'win32',
    () => { throw new Error('group kill must not run on Windows'); },
  );
  assert.equal(result, true);
  assert.deepEqual(directSignals, ['SIGKILL']);
});

test('a vanished Unix group falls back to the exact child handle', () => {
  const directSignals: NodeJS.Signals[] = [];
  const result = signalChildProcessGroup(
    { pid: 4242, kill: (signal) => { directSignals.push(signal as NodeJS.Signals); return false; } },
    'SIGTERM',
    'linux',
    () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  );
  assert.equal(result, false);
  assert.deepEqual(directSignals, ['SIGTERM']);
});
