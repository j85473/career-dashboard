import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { reclaimExpiredAtsWorkerSlots } = require('../../scripts/deployment/reclaim-expired-worker-slots.cjs');

test('M70 acquisition group shutdown allows the child to finish releasing its leases', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'm70-shutdown-'));
  const fixture = path.join(root, 'acquisition.mjs');
  const released = path.join(root, 'released');
  writeFileSync(fixture, `
    import fs from 'node:fs';
    setInterval(() => {}, 1000);
    process.once('SIGTERM', () => {
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(released)}, 'released');
        process.exit(0);
      }, 200);
    });
    console.log('READY:' + process.pid);
  `);
  const unit = readFileSync('scripts/deployment/m70/career-dashboard-acquisition.service', 'utf8');
  const command = unit.match(/^ExecStart=(.+)$/m)?.[1];
  assert.ok(command);
  const parts = command.split(/\s+/).map((part) => {
    if (part === '/usr/local/bin/node') return process.execPath;
    if (part === 'scripts/workers/ats-remote-continuation.ts') return fixture;
    return part;
  });
  const child = spawn(parts[0], parts.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  let errorOutput = '';
  child.stderr.on('data', (chunk) => { errorOutput += chunk; });
  const timeout = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, 10_000);
  try {
    const workerPid = await Promise.race([
      new Promise<number>((resolve) => child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/READY:(\d+)/);
        if (match) resolve(Number(match[1]));
      })),
      exited.then(() => { throw new Error(`Child exited before ready: ${errorOutput}`); }),
    ]);
    assert.ok(child.pid);
    // Group shutdown signals both the worker and any wrapper. Deliver to the
    // worker first, then let the wrapper run: this makes the scheduling race
    // reproducible instead of relying on the OS to coalesce two pending signals.
    process.kill(workerPid, 'SIGTERM');
    if (workerPid !== child.pid) {
      await delay(50);
      process.kill(child.pid, 'SIGTERM');
    }
    const [code, signal] = await exited;
    assert.equal(code, 0, errorOutput);
    assert.equal(signal, null, errorOutput);
    assert.equal(existsSync(released), true, 'shutdown skipped the lease cleanup');
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('deployment cleanup clears only expired capacity reservations and retains their fencing counters', async () => {
  const now = new Date('2026-09-02T21:40:00Z');
  const rows = [
    { leaseToken: 'expired', leaseExpiresAt: new Date(now.getTime() - 1), leaseFence: BigInt(8) },
    { leaseToken: 'boundary', leaseExpiresAt: now, leaseFence: BigInt(9) },
    { leaseToken: 'live', leaseExpiresAt: new Date(now.getTime() + 60_000), leaseFence: BigInt(10) },
    { leaseToken: 'unknown-expiry', leaseExpiresAt: null, leaseFence: BigInt(11) },
    { leaseToken: null, leaseExpiresAt: new Date(now.getTime() - 1), leaseFence: BigInt(12) },
  ];
  let writes = 0;
  const prisma = {
    atsAcquisitionWorkerSlot: {
      async updateMany({ where, data }: {
        where: { leaseToken: { not: null }; leaseExpiresAt: { lte: Date } };
        data: Record<string, null>;
      }) {
        // The expiry belongs in the atomic UPDATE predicate: selecting a stale
        // token first and clearing it unconditionally could erase its renewal.
        assert.deepEqual(where, { leaseToken: { not: null }, leaseExpiresAt: { lte: now } });
        assert.deepEqual(Object.keys(data).sort(), [
          'acquiredAt', 'heartbeatAt', 'leaseExpiresAt', 'leaseOwner', 'leaseToken', 'releaseId', 'workerKind',
        ]);
        let count = 0;
        for (const row of rows) {
          if (row.leaseToken !== where.leaseToken.not && row.leaseExpiresAt !== null
            && row.leaseExpiresAt <= where.leaseExpiresAt.lte) {
            Object.assign(row, data);
            count++;
          }
        }
        writes++;
        return { count };
      },
    },
  };
  assert.equal(await reclaimExpiredAtsWorkerSlots(prisma, now), 2);
  assert.equal(writes, 1);
  assert.deepEqual(rows.map((row) => row.leaseToken), [null, null, 'live', 'unknown-expiry', null]);
  assert.deepEqual(rows.map((row) => row.leaseFence), [BigInt(8), BigInt(9), BigInt(10), BigInt(11), BigInt(12)]);
});
