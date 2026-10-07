import assert from 'node:assert/strict';
import test from 'node:test';

import { atsRequestLeaseKey } from '../atsRequestConcurrency';
import { fetchAtsPlatformResponse, platformPauseRemainingMs } from '../jobIngestion';
import { enrichAtsListingJob } from '../atsJobEnrichment';
import { fetchAtsBoardPage } from '../atsAcquisition';
import { prisma } from '../prisma';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function oracleHosts(): [string, string] {
  const hosts = new Map<string, string>();
  for (let index = 0; hosts.size < 2 && index < 100; index++) {
    const url = `https://tenant${index}.fa.us6.oraclecloud.com/listing`;
    hosts.set(atsRequestLeaseKey('oracle', url), url);
  }
  assert.equal(hosts.size, 2);
  return [...hosts.values()] as [string, string];
}

test('Oracle request keys have two fixed buckets and preserve tenant serialization', () => {
  const keys = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const url = `https://tenant${index}.fa.us6.oraclecloud.com/listing`;
    const key = atsRequestLeaseKey('oracle', url);
    keys.add(key);
    assert.equal(atsRequestLeaseKey('oracle', url.replace('/listing', '/detail?job=12')), key);
  }
  assert.deepEqual([...keys].sort(), ['ATS-oracle', 'ATS-oracle:request-slot:1']);
  for (const invalid of [undefined, 'bad-url', 'https://oraclecloud.com.attacker.test/job', 'http://a.oraclecloud.com']) {
    assert.equal(atsRequestLeaseKey('oracle', invalid), 'ATS-oracle');
  }
  assert.equal(atsRequestLeaseKey('workable', oracleHosts()[0]), 'ATS-workable');
  assert.equal(atsRequestLeaseKey('workday', oracleHosts()[0]), 'ATS-workday');
});

test('Oracle overlaps two host buckets and never dispatches more than two requests', async () => {
  const hosts = oracleHosts();
  const release = deferred();
  const bothStarted = deferred();
  const leaseKeys = new Set<string | undefined>();
  let active = 0;
  let maximum = 0;
  let started = 0;
  const requests = Array.from({ length: 6 }, (_, index) => fetchAtsPlatformResponse(
    'oracle', undefined, async () => {
      active++;
      started++;
      maximum = Math.max(maximum, active);
      if (started === 2) bothStarted.resolve();
      await release.promise;
      active--;
      return new Response('{}');
    }, {
      requestedUrl: hosts[index % 2], waitForSlot: async () => {},
      withCrossProcessLease: async (action, key) => { leaseKeys.add(key); return action(); },
    },
  ));
  await bothStarted.promise;
  assert.equal(started, 2);
  release.resolve();
  await Promise.all(requests);
  assert.equal(started, 6);
  assert.equal(maximum, 2);
  assert.deepEqual([...leaseKeys].sort(), ['ATS-oracle', 'ATS-oracle:request-slot:1']);
});

test('aborting a queued Oracle request cannot let its successor bypass the active host', async () => {
  const firstStarted = deferred();
  const release = deferred();
  const aborted = new AbortController();
  const starts: number[] = [];
  const options = {
    requestedUrl: oracleHosts()[0], waitForSlot: async () => {},
    withCrossProcessLease: async (action: () => Promise<Response>) => action(),
  };
  const first = fetchAtsPlatformResponse('oracle', undefined, async () => {
    starts.push(1);
    firstStarted.resolve();
    await release.promise;
    return new Response('{}');
  }, options);
  await firstStarted.promise;
  const second = fetchAtsPlatformResponse('oracle', aborted.signal, async () => {
    starts.push(2);
    return new Response('{}');
  }, options);
  aborted.abort(new Error('stop queued request'));
  await assert.rejects(second, /stop queued request/);
  const third = fetchAtsPlatformResponse('oracle', undefined, async () => {
    starts.push(3);
    return new Response('{}');
  }, options);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1]);
  release.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(starts, [1, 3]);
});

test('Oracle listing and detail buckets both reread the shared persisted circuit inside their lease', async (t) => {
  const leases = new Set<string>();
  const heldLeases = new Set<string>();
  const reads: string[] = [];
  const openUntil = new Date(Date.now() + 120_000);
  // Prisma delegates are dynamic proxy properties without method descriptors.
  const original = {
    upsert: prisma.providerCircuit.upsert,
    updateMany: prisma.providerCircuit.updateMany,
    findUnique: prisma.providerCircuit.findUnique,
  };
  t.after(() => { Object.assign(prisma.providerCircuit, original); });
  Object.assign(prisma.providerCircuit, { upsert: async () => ({}) });
  Object.assign(prisma.providerCircuit, { updateMany: async (query: {
    where: { provider: string }; data: { requestLeaseToken: string | null };
  }) => {
    if (query.data.requestLeaseToken) {
      leases.add(query.where.provider);
      heldLeases.add(query.where.provider);
    } else heldLeases.delete(query.where.provider);
    return { count: 1 };
  } });
  Object.assign(prisma.providerCircuit, { findUnique: async (query: { where: { provider: string } }) => {
    reads.push(query.where.provider);
    assert.ok(heldLeases.size > 0, 'circuit was checked before the request lease');
    assert.equal(query.where.provider, 'ATS-oracle', 'request bucket replaced the circuit authority');
    return { provider: 'ATS-oracle', state: 'open', openUntil, dailyUsed: 0, monthlyUsed: 0,
      dailyLimit: null, monthlyLimit: null, lastError: 'HTTP 429' };
  } });
  let requested = false;
  t.mock.method(globalThis, 'fetch', async () => { requested = true; throw new Error('unexpected fetch'); });
  for (const host of oracleHosts()) {
    const hostname = new URL(host).hostname;
    const slug = `${hostname}::CX`;
    await assert.rejects(fetchAtsBoardPage({ platform: 'oracle', slug }, 0), /circuit_open/);
    await assert.rejects(enrichAtsListingJob({
      platform: 'oracle', slug, requestTimeoutMs: 1_000,
      job: { title: 'Channel Manager', company: 'Acme', publicAtsPostingId: '123',
        url: `https://${hostname}/hcmUI/CandidateExperience/en/sites/CX/job/123/` },
    }), /deferred by the platform circuit/);
  }
  assert.deepEqual([...leases].sort(), ['ATS-oracle', 'ATS-oracle:request-slot:1']);
  assert.deepEqual(reads, ['ATS-oracle', 'ATS-oracle', 'ATS-oracle', 'ATS-oracle']);
  assert.equal(requested, false);
  assert.equal(heldLeases.size, 0);
});

test('an Oracle detail 429 keeps a durable platform cooldown shared by both buckets', async () => {
  const recorded: Array<{ platform: string; pauseMs: number }> = [];
  const hosts = oracleHosts();
  await fetchAtsPlatformResponse('oracle', undefined,
    async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }), {
      requestedUrl: hosts[0], waitForSlot: async () => {},
      withCrossProcessLease: (action) => action(), recordPlatformFailures: false,
      recordThrottle: async (platform, pauseMs) => { recorded.push({ platform, pauseMs }); },
    });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].platform, 'oracle');
  assert.ok(recorded[0].pauseMs >= 120_000);
  let checked = false;
  await assert.rejects(fetchAtsPlatformResponse('oracle', undefined,
    async () => { throw new Error('request should remain paused'); }, {
      requestedUrl: hosts[1],
      waitForSlot: async (platform) => {
        checked = true;
        assert.equal(platform, 'oracle');
        assert.ok(platformPauseRemainingMs(platform) > 110_000);
        throw new Error('shared platform cooldown');
      },
      withCrossProcessLease: (action) => action(),
    }), /shared platform cooldown/);
  assert.equal(checked, true);
});
