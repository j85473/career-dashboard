import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIngestionTaskKey } from '../ingestionControl';
import {
  applyAtsTaskModeTransition,
  planAtsTaskModeTransition,
  type AtsTaskModeRow,
} from '../atsTaskMode';
import {
  ATS_ACQUISITION_TASK_DEFINITION,
  atsPlatformTaskDefinition,
} from '../ingestionTaskCatalog';

function taskRow(input: Partial<AtsTaskModeRow> & Pick<AtsTaskModeRow, 'id' | 'source' | 'ingestionMode'>): AtsTaskModeRow {
  const spec = input.ingestionMode === 'ats-acquisition'
    ? ATS_ACQUISITION_TASK_DEFINITION.spec
    : atsPlatformTaskDefinition(input.source.replace(/^ATS-/, '')).spec;
  return {
    id: input.id,
    taskKey: input.taskKey || buildIngestionTaskKey(spec),
    source: input.source,
    ingestionMode: input.ingestionMode,
    taskKind: input.taskKind || 'search',
    lifecycleStatus: input.lifecycleStatus || 'active',
    retiredAt: input.retiredAt ?? null,
    status: input.status || 'succeeded',
    leaseToken: input.leaseToken ?? null,
    leaseOwner: input.leaseOwner ?? null,
    leaseStartedAt: input.leaseStartedAt ?? null,
    heartbeatAt: input.heartbeatAt ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    lastError: input.lastError ?? null,
  };
}

test('split mode activates the acquisition task and retires only unleased legacy ATS rows', () => {
  const acquisition = taskRow({
    id: 'acquisition',
    source: 'Direct ATS acquisition',
    ingestionMode: 'ats-acquisition',
    lifecycleStatus: 'retired',
    retiredAt: new Date('2026-08-01T00:00:00Z'),
  });
  const legacyActive = taskRow({ id: 'legacy-active', source: 'ATS-workday', ingestionMode: 'ats' });
  const legacyRetired = taskRow({
    id: 'legacy-retired',
    source: 'ATS-greenhouse',
    ingestionMode: 'ats',
    lifecycleStatus: 'retired',
    retiredAt: new Date('2026-08-01T00:00:00Z'),
  });
  const unrelated = taskRow({
    id: 'unrelated',
    source: 'ATS-like feed',
    ingestionMode: 'route-source',
    taskKey: 'unrelated',
  });

  const plan = planAtsTaskModeTransition({
    splitEnabled: true,
    rows: [acquisition, legacyActive, legacyRetired, unrelated],
    legacyPlatforms: ['workday', 'greenhouse'],
  });

  assert.deepEqual(plan.activate.map((action) => action.row?.id), ['acquisition']);
  assert.deepEqual(plan.retire.map((row) => row.id), ['legacy-active']);
  assert.deepEqual(plan.blocked, []);
});

test('legacy fallback reverses the scoped lifecycle transition', () => {
  const acquisition = taskRow({ id: 'acquisition', source: 'Direct ATS acquisition', ingestionMode: 'ats-acquisition' });
  const legacy = taskRow({
    id: 'legacy',
    source: 'ATS-workday',
    ingestionMode: 'ats',
    lifecycleStatus: 'retired',
    retiredAt: new Date('2026-08-01T00:00:00Z'),
  });

  const plan = planAtsTaskModeTransition({
    splitEnabled: false,
    rows: [acquisition, legacy],
    legacyPlatforms: ['workday'],
  });

  assert.deepEqual(plan.activate.map((action) => action.row?.id), ['legacy']);
  assert.deepEqual(plan.retire.map((row) => row.id), ['acquisition']);
  assert.deepEqual(plan.blocked, []);
});

test('a leased row blocks the whole mode transition instead of being mutated', () => {
  const legacy = taskRow({
    id: 'leased-legacy',
    source: 'ATS-workday',
    ingestionMode: 'ats',
    status: 'running',
    leaseToken: 'live-lease',
  });

  const plan = planAtsTaskModeTransition({
    splitEnabled: true,
    rows: [legacy],
    legacyPlatforms: ['workday'],
  });

  assert.deepEqual(plan.blocked.map((row) => row.id), ['leased-legacy']);
});

test('an already-retired opposite-lane row still blocks while its lease is live', () => {
  const legacy = taskRow({
    id: 'retired-but-leased',
    source: 'ATS-workday',
    ingestionMode: 'ats',
    lifecycleStatus: 'retired',
    retiredAt: new Date('2026-08-27T00:00:00Z'),
    status: 'running',
    leaseToken: 'live-lease',
  });

  const plan = planAtsTaskModeTransition({
    splitEnabled: true,
    rows: [legacy],
    legacyPlatforms: ['workday'],
  });

  assert.deepEqual(plan.retire, []);
  assert.deepEqual(plan.blocked.map((row) => row.id), ['retired-but-leased']);
});

test('an expired opposite-lane lease is recoverable instead of deadlocking startup', async () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const legacy = taskRow({
    id: 'expired-legacy',
    source: 'ATS-workday',
    ingestionMode: 'ats',
    status: 'running',
    leaseToken: 'expired-lease',
    leaseOwner: 'old-host:123',
    leaseStartedAt: new Date('2026-08-27T10:00:00Z'),
    heartbeatAt: new Date('2026-08-27T10:05:00Z'),
    leaseExpiresAt: new Date('2026-08-27T10:35:00Z'),
    lastError: 'prior warning',
  });
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    atsCompany: { findMany: async () => [{ platform: 'workday' }] },
    ingestionTask: {
      findMany: async () => [legacy],
      updateMany: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: 1 };
      },
      create: async () => ({ id: 'acquisition' }),
    },
  };

  const result = await applyAtsTaskModeTransition(client as never, { splitEnabled: true, now });

  assert.equal(result.recoveredStaleLeases, 1);
  assert.equal(result.retired, 1);
  assert.equal(result.activated, 1);
  assert.equal(updates.length, 2, 'stale recovery must precede the retirement update');
  const recovery = updates[0];
  assert.deepEqual(recovery.where, {
    id: 'expired-legacy',
    leaseExpiresAt: { lte: now },
    leaseToken: 'expired-lease',
  });
  assert.equal((recovery.data as Record<string, unknown>).status, 'failed');
  assert.equal((recovery.data as Record<string, unknown>).leaseToken, null);
  assert.match(String((recovery.data as Record<string, unknown>).lastError), /prior warning.*lease expired/i);
});

test('mode application preserves task counters and history by updating lifecycle fields only', async () => {
  const acquisition = taskRow({
    id: 'acquisition',
    source: 'Direct ATS acquisition',
    ingestionMode: 'ats-acquisition',
    lifecycleStatus: 'retired',
    retiredAt: new Date('2026-08-01T00:00:00Z'),
  });
  const legacy = taskRow({ id: 'legacy', source: 'ATS-workday', ingestionMode: 'ats' });
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    atsCompany: {
      findMany: async () => [{ platform: 'workday' }],
    },
    ingestionTask: {
      findMany: async () => [acquisition, legacy],
      updateMany: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { count: 1 };
      },
      create: async () => {
        throw new Error('no create expected');
      },
    },
  };

  const result = await applyAtsTaskModeTransition(client as never, {
    splitEnabled: true,
    now: new Date('2026-08-27T12:00:00Z'),
  });

  assert.equal(result.activated, 1);
  assert.equal(result.retired, 1);
  assert.equal(updates.length, 2);
  for (const update of updates) {
    const data = update.data as Record<string, unknown>;
    assert.equal('attempt' in data, false);
    assert.equal('requestCount' in data, false);
    assert.equal('cursor' in data, false);
    assert.equal('watermarkAt' in data, false);
    assert.equal('lastCompletedAt' in data, false);
  }
});
