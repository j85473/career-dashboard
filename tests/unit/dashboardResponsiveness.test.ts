import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDashboardPressureCheck, createDashboardResponsivenessRecorder, dashboardResponsivenessPressure,
  type DashboardResponsiveness,
} from '../../src/lib/dashboardResponsiveness';
import { AtsWebDiscoveryState } from '../../src/lib/atsWebDiscoveryState';
import { runAtsWebDiscovery } from '../../src/lib/atsWebDiscovery';
import { runDiscoveryWithBackoff } from '../../scripts/crawl_ats_boards';

function fixture() {
  let clock = 1_000_000;
  let saved: DashboardResponsiveness | undefined;
  const recorder = createDashboardResponsivenessRecorder({ now: () => clock, pid: 123,
    publish: async snapshot => { saved = snapshot; } });
  return { recorder, now: () => clock, advance: (ms: number) => { clock += ms; },
    pressure: () => dashboardResponsivenessPressure(saved, clock, () => true) };
}

test('web startup initializes healthy idle telemetry without a visitor request', async () => {
  const f = fixture();
  f.recorder.initialize();
  await f.recorder.flush();
  assert.equal(f.pressure(), null);
  assert.equal(f.recorder.snapshot().lastCompletedAt, null);
  assert.equal(f.recorder.snapshot().activeRequests, 0);
});

test('fast lists and invalid search inputs do not hold discovery or require idle polling', async () => {
  const f = fixture();
  const response = { status: 200, payload: 'unchanged' };
  assert.equal(await f.recorder.track(async () => { f.advance(200); return response; }), response);
  await f.recorder.flush();
  assert.equal(f.pressure(), null);
  await f.recorder.track(async () => ({ status: 400 }));
  await f.recorder.flush();
  assert.equal(f.pressure(), null);
  f.advance(600_000);
  assert.equal(f.pressure(), null);
});

test('a slow in-flight list pauses discovery and retains a minute of recovery after completion', async () => {
  const f = fixture();
  let finish!: (value: { status: number }) => void;
  const response = f.recorder.track(() => new Promise<{ status: number }>(resolve => { finish = resolve; }));
  await f.recorder.flush();
  assert.equal(f.pressure(), null);
  f.advance(1500);
  assert.equal(f.pressure(), 'paused_for_dashboard_response');
  finish({ status: 200 });
  await response;
  await f.recorder.flush();
  f.advance(59_999);
  assert.equal(f.pressure(), 'paused_for_dashboard_response');
  f.advance(1);
  assert.equal(f.pressure(), null);
});

test('overlapping lists retain the oldest active request when a newer request finishes', async () => {
  const f = fixture();
  let finish!: (value: { status: number }) => void;
  const old = f.recorder.track(() => new Promise<{ status: number }>(resolve => { finish = resolve; }));
  f.advance(1000);
  await f.recorder.track(async () => ({ status: 200 }));
  await f.recorder.flush();
  f.advance(500);
  assert.equal(f.recorder.snapshot().activeRequests, 1);
  assert.equal(f.pressure(), 'paused_for_dashboard_response');
  finish({ status: 200 });
  await old;
  await f.recorder.flush();
  assert.equal(f.recorder.snapshot().activeRequests, 0);
});

test('server errors and exceptions retain their original result and pause discovery', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    const failure = new Error('query failed');
    const handler = async () => { if (throws) throw failure; return { status: 500 }; };
    if (throws) await assert.rejects(f.recorder.track(handler), error => error === failure);
    else assert.equal((await f.recorder.track(handler)).status, 500);
    await f.recorder.flush();
    assert.equal(f.pressure(), 'paused_for_dashboard_response');
  }
});

test('slow or failed telemetry writes never delay or fail a user response', async () => {
  let release!: () => void;
  let writes = 0;
  const recorder = createDashboardResponsivenessRecorder({ publish: async () => {
    writes++;
    if (writes === 1) await new Promise<void>(resolve => { release = resolve; });
    else throw new Error('disk unavailable');
  } });
  const response = { status: 200 };
  assert.equal(await recorder.track(async () => response), response);
  release();
  await recorder.flush();
  assert.equal(writes, 2, 'completion is coalesced after the slow initial write');
});

test('missing, malformed, oversized, and dead-process telemetry keep faster discovery paused', () => {
  const good: DashboardResponsiveness = { version: 1, pid: 123, updatedAt: 1000, activeRequests: 0,
    oldestActiveAt: null, lastCompletedAt: 1000, lastDurationMs: 100, cooldownUntil: 0 };
  assert.equal(dashboardResponsivenessPressure(good, 1000, () => false), 'paused_for_dashboard_telemetry');
  for (const raw of ['bad json', 'null', '{}', JSON.stringify({ ...good, oldestActiveAt: 10 }), ' '.repeat(5000)]) {
    assert.equal(createDashboardPressureCheck('/fixture', { read: () => raw, now: () => 1000, isAlive: () => true })(),
      'paused_for_dashboard_telemetry');
  }
  assert.equal(createDashboardPressureCheck('/fixture', { read: () => { throw new Error('missing'); } })(),
    'paused_for_dashboard_telemetry');
  assert.equal(createDashboardPressureCheck(undefined)(), null, 'local experiments remain opt-in');
});

test('pressure checks cache file reads briefly and notice request recovery', () => {
  let at = 1000;
  let reads = 0;
  const sample = { version: 1, pid: 123, updatedAt: at, activeRequests: 0,
    oldestActiveAt: null, lastCompletedAt: at, lastDurationMs: 1600, cooldownUntil: 2000 };
  const check = createDashboardPressureCheck('/fixture', { now: () => at, isAlive: () => true,
    read: () => { reads++; return JSON.stringify(sample); } });
  assert.equal(check(), 'paused_for_dashboard_response');
  at = 1999;
  assert.equal(check(), 'paused_for_dashboard_response');
  assert.equal(reads, 1);
  at = 2000;
  assert.equal(check(), null);
  assert.equal(reads, 2);
});

test('resource pauses survive restarts without extending cooldown or changing queued work', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'discovery-backoff-'));
  const filename = path.join(directory, 'state.sqlite');
  let state = new AtsWebDiscoveryState(filename);
  let clock = 1_000_000;
  let calls = 0;
  try {
    state.enqueue('https://employer.example/careers', 'https://directory.example', 1, 100, clock, 500_000);
    const run = () => {
      calls++;
      return runAtsWebDiscovery(state, [], {}, { now: () => clock,
        pressure: () => 'paused_for_dashboard_response', request: async () => { throw new Error('must not fetch'); } });
    };
    const before = state.report();
    assert.equal((await runDiscoveryWithBackoff(state, run, 500_000, () => clock)).stopReason, 'paused_for_dashboard_response');
    state.close();
    state = new AtsWebDiscoveryState(filename);
    clock += 15_000;
    assert.equal((await runDiscoveryWithBackoff(state, run, 500_000, () => clock)).stopReason, 'paused_for_resource_cooldown');
    assert.equal(calls, 1);
    assert.equal(state.metric('resourceBackoffUntil'), 1_060_000);
    assert.deepEqual(state.report(), before);
    clock = 1_060_000;
    assert.equal((await runDiscoveryWithBackoff(state, run, 500_000, () => clock)).stopReason, 'paused_for_dashboard_response');
    assert.equal(calls, 2);
  } finally { state.close(); rmSync(directory, { recursive: true, force: true }); }
});
