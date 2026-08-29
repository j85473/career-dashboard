import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_ACQUISITION_DATABASE_CONNECTION_LIMIT,
  buildAtsAcquisitionWorkerLaunchConfig,
  runAtsAcquisitionWorkerProcess,
} from '../pipelineWorkerProcess';

const TEST_DATABASE_URL = 'postgresql://worker:secret@localhost:5432/career?schema=public&sslmode=prefer&connection_limit=99';

test('ATS worker launch uses the production tsx loader, attached IPC, and a capped database pool', () => {
  const launch = buildAtsAcquisitionWorkerLaunchConfig({
    cwd: '/srv/career-dashboard/current',
    environment: { DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'production' },
  });
  const childUrl = new URL(String(launch.options.env?.DATABASE_URL));

  assert.equal(launch.executable, process.execPath);
  assert.equal(launch.workerPath, '/srv/career-dashboard/current/scripts/workers/ats-acquisition.ts');
  assert.deepEqual(launch.args, [
    '--import',
    'tsx',
    '/srv/career-dashboard/current/scripts/workers/ats-acquisition.ts',
  ]);
  assert.deepEqual(launch.options.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
  assert.equal(launch.options.detached, false);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.env?.PIPELINE_WORKER_ROLE, 'ats-acquisition');
  assert.equal(childUrl.searchParams.get('connection_limit'), String(ATS_ACQUISITION_DATABASE_CONNECTION_LIMIT));
  assert.equal(childUrl.searchParams.get('pool_timeout'), '5');
  assert.equal(childUrl.searchParams.get('connect_timeout'), '5');
  assert.equal(childUrl.searchParams.get('schema'), 'public');
  assert.equal(childUrl.searchParams.get('sslmode'), 'prefer');
});

test('attached ATS worker has a different PID and honors structured bounded stop', { timeout: 15_000 }, async () => {
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), 'ats-worker-stop-'));
  const fixturePath = path.join(fixtureDirectory, 'worker.mjs');
  writeFileSync(fixturePath, `
    const timer = setInterval(() => {}, 1000);
    process.send({ type: 'ready', role: 'ats-acquisition', pid: process.pid });
    process.on('message', (message) => {
      if (message?.type !== 'stop') return;
      clearInterval(timer);
      process.send({ type: 'stopped', role: 'ats-acquisition', pid: process.pid, reason: 'stop-requested' }, () => {
        process.disconnect();
      });
    });
  `);

  try {
    const controller = new AbortController();
    let resolveReady: (pid: number) => void = () => undefined;
    const ready = new Promise<number>((resolve) => { resolveReady = resolve; });
    const running = runAtsAcquisitionWorkerProcess({
      signal: controller.signal,
      shouldStop: async () => false,
      environment: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      workerPath: fixturePath,
      onReady: resolveReady,
      stopGraceMs: 2_000,
      termGraceMs: 1_000,
    });

    const childPid = await ready;
    assert.notEqual(childPid, process.pid);
    controller.abort();
    const exit = await running;
    assert.equal(exit.pid, childPid);
    assert.equal(exit.reason.reason, 'stop-requested');
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('attached ATS worker forwards structured backpressure telemetry to the parent', { timeout: 15_000 }, async () => {
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), 'ats-worker-backpressure-'));
  const fixturePath = path.join(fixtureDirectory, 'worker.mjs');
  writeFileSync(fixturePath, `
    const timer = setInterval(() => {}, 1000);
    process.send({ type: 'ready', role: 'ats-acquisition', pid: process.pid });
    process.send({
      type: 'backpressure',
      role: 'ats-acquisition',
      pid: process.pid,
      active: true,
      remainingJobs: 2345,
      highWatermark: 2000,
      lowWatermark: 1000,
    });
    process.on('message', (message) => {
      if (message?.type !== 'stop') return;
      clearInterval(timer);
      process.send({ type: 'stopped', role: 'ats-acquisition', pid: process.pid, reason: 'stop-requested' }, () => {
        process.disconnect();
      });
    });
  `);

  try {
    const controller = new AbortController();
    type ObservedBackpressure = {
      pid: number;
      active: boolean;
      remainingJobs: number;
      highWatermark: number;
      lowWatermark: number;
    };
    let resolveTelemetry: (value: ObservedBackpressure) => void = () => undefined;
    const telemetry = new Promise<ObservedBackpressure>((resolve) => {
      resolveTelemetry = resolve;
    });
    const running = runAtsAcquisitionWorkerProcess({
      signal: controller.signal,
      shouldStop: async () => false,
      environment: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      workerPath: fixturePath,
      onBackpressure: (pid, state) => resolveTelemetry({ pid, ...state }),
      stopGraceMs: 2_000,
      termGraceMs: 1_000,
    });

    const observed = await telemetry;
    assert.notEqual(observed.pid, process.pid);
    assert.deepEqual({
      active: observed.active,
      remainingJobs: observed.remainingJobs,
      highWatermark: observed.highWatermark,
      lowWatermark: observed.lowWatermark,
    }, {
      active: true,
      remainingJobs: 2345,
      highWatermark: 2000,
      lowWatermark: 1000,
    });
    controller.abort();
    await running;
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('bounded stop terminates only an unresponsive attached child and still settles as a stop', { timeout: 15_000 }, async () => {
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), 'ats-worker-force-stop-'));
  const fixturePath = path.join(fixtureDirectory, 'worker.mjs');
  writeFileSync(fixturePath, `
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {});
    process.on('message', () => {});
    process.send({ type: 'ready', role: 'ats-acquisition', pid: process.pid });
  `);

  try {
    const controller = new AbortController();
    let resolveReady: (pid: number) => void = () => undefined;
    const ready = new Promise<number>((resolve) => { resolveReady = resolve; });
    const running = runAtsAcquisitionWorkerProcess({
      signal: controller.signal,
      shouldStop: async () => false,
      environment: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      workerPath: fixturePath,
      onReady: resolveReady,
      stopGraceMs: 50,
      termGraceMs: 50,
    });

    const childPid = await ready;
    controller.abort();
    const exit = await running;
    assert.equal(exit.pid, childPid);
    assert.equal(exit.reason.reason, 'stop-requested');
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('an ATS worker crash is reported only after the crashed PID closes', { timeout: 15_000 }, async () => {
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), 'ats-worker-crash-'));
  const fixturePath = path.join(fixtureDirectory, 'worker.mjs');
  writeFileSync(fixturePath, `
    process.send({ type: 'ready', role: 'ats-acquisition', pid: process.pid });
    setTimeout(() => process.exit(23), 20);
  `);

  try {
    const seenPids: number[] = [];
    await assert.rejects(
      runAtsAcquisitionWorkerProcess({
        signal: new AbortController().signal,
        shouldStop: async () => false,
        environment: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        workerPath: fixturePath,
        onReady: (pid) => seenPids.push(pid),
      }),
      /worker PID \d+ exited unexpectedly.*exit code 23/,
    );
    assert.equal(seenPids.length, 1);
    assert.notEqual(seenPids[0], process.pid);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('a child-only signal is unexpected so the route supervisor can replace that PID', { timeout: 15_000 }, async () => {
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), 'ats-worker-signal-'));
  const fixturePath = path.join(fixtureDirectory, 'worker.mjs');
  writeFileSync(fixturePath, `
    process.send({ type: 'ready', role: 'ats-acquisition', pid: process.pid });
    setTimeout(() => {
      process.send({ type: 'stopped', role: 'ats-acquisition', pid: process.pid, reason: 'signal' }, () => {
        process.disconnect();
      });
    }, 20);
  `);

  try {
    await assert.rejects(
      runAtsAcquisitionWorkerProcess({
        signal: new AbortController().signal,
        shouldStop: async () => false,
        environment: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        workerPath: fixturePath,
      }),
      /worker PID \d+ exited unexpectedly/,
    );
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
