import assert from 'node:assert/strict';
import test from 'node:test';

import { planAtsRequest, withAtsLocalRequestCapacity } from '../atsRequestConcurrency';
import { fetchAtsPlatformResponse, platformPauseRemainingMs } from '../jobIngestion';
import { enrichAtsListingJob } from '../atsJobEnrichment';
import { fetchAtsBoardPage } from '../atsAcquisition';
import { prisma } from '../prisma';
import { withProviderRequestCapacity } from '../ingestionControl';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function oracleHosts(): [string, string] {
  return ['https://tenant1.fa.us6.oraclecloud.com/listing', 'https://tenant2.fa.us6.oraclecloud.com/listing'];
}

test('independent Oracle hosts have distinct fences without hash-bucket collisions', () => {
  const keys = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const url = `https://tenant${index}.fa.us6.oraclecloud.com/listing`;
    const key = planAtsRequest('oracle', url).boardLeaseKey!;
    keys.add(key);
    assert.equal(planAtsRequest('oracle', url.replace('/listing', '/detail?job=12')).boardLeaseKey, key);
  }
  assert.equal(keys.size, 100);
  for (const invalid of [undefined, 'bad-url', 'https://oraclecloud.com.attacker.test/job', 'http://a.oraclecloud.com']) {
    assert.equal(planAtsRequest('oracle', invalid).units, 2);
    assert.equal(planAtsRequest('oracle', invalid).boardLeaseKey, null);
  }
  assert.equal(planAtsRequest('workable', oracleHosts()[0]).providerKey, 'ATS-workable');
  assert.equal(planAtsRequest('workday', oracleHosts()[0]).providerKey, 'ATS-workday');
});

test('Oracle overlaps independent hosts and never dispatches more than two requests', async () => {
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
  assert.deepEqual([...leases].filter(key => key.startsWith('ATS-oracle')).sort(), ['ATS-oracle', 'ATS-oracle:request-slot:1']);
  assert.equal([...leases].filter(key => key.startsWith('ats-request-board:oracle:')).length, 2);
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


test('all mapped API providers use independent employer fences', () => {
  const platforms = ['ashby','bamboohr','breezy','greenhouse','eightfold','dayforce','oracle','ukg',
    'comeet','successfactors','lever','personio','pinpoint','recruitee','rippling','smartrecruiters',
    'teamtailor','workable','workday','zohorecruit','gem','jobscore','jazzhr','manatal','clearcompany','hirehive'];
  for (const platform of platforms) {
    const a = planAtsRequest(platform, 'https://careers.example.com/listing', 'employer-a');
    const b = planAtsRequest(platform, 'https://careers.example.com/listing', 'employer-b');
    assert.equal(a.units, 1, platform);
    assert.notEqual(a.boardLeaseKey, b.boardLeaseKey, platform);
    assert.equal(a.providerKey, 'ATS-' + platform);
  }
});
test('Workday sites on the same employer and shared-host APIs keep stable board fences', () => {
  assert.equal(planAtsRequest('workday','https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/A/jobs','acme.wd5::A').boardLeaseKey,
    planAtsRequest('workday','https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/B/job/x','acme.wd5::B').boardLeaseKey);
  for (const [platform, list, detail] of [
    ['greenhouse','https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true','https://boards-api.greenhouse.io/v1/boards/acme/jobs/123'],
    ['lever','https://api.lever.co/v0/postings/acme','https://api.lever.co/v0/postings/acme/123'],
    ['workable','https://www.workable.com/api/accounts/acme?details=true','https://apply.workable.com/api/v1/accounts/acme/jobs/123'],
    ['smartrecruiters','https://api.smartrecruiters.com/v1/companies/acme/postings','https://api.smartrecruiters.com/v1/companies/acme/postings/123'],
  ]) {
    assert.equal(planAtsRequest(platform,list).units,1);
    assert.equal(planAtsRequest(platform,list).boardLeaseKey,planAtsRequest(platform,detail).boardLeaseKey);
  }
  assert.equal(planAtsRequest('zohorecruit','https://acme.zohorecruit.com/jobs/Careers','acme.zohorecruit.com::Careers').boardLeaseKey,
    planAtsRequest('zohorecruit','https://acme.zohorecruit.com/recruit/v2/public/Job_Openings?pagename=Careers','acme.zohorecruit.com::Careers').boardLeaseKey);
});
test('unidentified calls reserve the full pool and cannot be bypassed', async () => {
  const known = planAtsRequest('greenhouse','https://boards-api.greenhouse.io/v1/boards/acme/jobs');
  const unknown = planAtsRequest('greenhouse');
  const firstRelease=deferred(), exclusiveRelease=deferred(), exclusiveStarted=deferred();
  const starts: string[]=[];
  const first=withAtsLocalRequestCapacity(known,undefined,async()=>{starts.push('first');await firstRelease.promise;});
  await new Promise<void>(resolve=>setImmediate(resolve));
  const exclusive=withAtsLocalRequestCapacity(unknown,undefined,async()=>{starts.push('exclusive');exclusiveStarted.resolve();await exclusiveRelease.promise;});
  const next=withAtsLocalRequestCapacity(known,undefined,async()=>{starts.push('next');});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(starts,['first']);
  firstRelease.resolve();await exclusiveStarted.promise;
  assert.deepEqual(starts,['first','exclusive']);
  exclusiveRelease.resolve();await Promise.all([first,exclusive,next]);
  assert.deepEqual(starts,['first','exclusive','next']);
});
test('a cancelled capacity waiter neither leaks slots nor blocks other providers', async () => {
  const plan=planAtsRequest('ashby','https://api.ashbyhq.com/posting-api/job-board/acme');
  const release=deferred(), started=deferred();
  let starts=0;
  const owners=[0,1].map(()=>withAtsLocalRequestCapacity(plan,undefined,async()=>{if(++starts===2)started.resolve();await release.promise;}));
  await started.promise;
  const controller=new AbortController();
  const cancelled=withAtsLocalRequestCapacity(plan,controller.signal,async()=>{throw new Error('cancelled waiter executed');});
  controller.abort(new Error('stop waiter'));
  await assert.rejects(cancelled,/stop waiter/);
  let independent=false;
  await withAtsLocalRequestCapacity(planAtsRequest('lever','https://api.lever.co/v0/postings/acme'),undefined,async()=>{independent=true;});
  assert.equal(independent,true);
  release.resolve();await Promise.all(owners);
  await withAtsLocalRequestCapacity(plan,undefined,async()=>{starts++;});
  assert.equal(starts,3);
});
test('Workday overlaps different employers, while listing and detail for one host remain serial', async () => {
  const release=deferred(), started=deferred();
  let active=0,maximum=0,starts=0;
  const options={waitForSlot:async()=>{},withCrossProcessLease:async(action:()=>Promise<Response>)=>action()};
  const requests=[0,1,2,3].map(index=>fetchAtsPlatformResponse('workday',undefined,async()=>{
    maximum=Math.max(maximum,++active);if(++starts===2)started.resolve();
    await release.promise;active--;return new Response('{}');
  },{...options,requestedUrl:'https://tenant'+(index%2)+'.wd5.myworkdayjobs.com/wday/cxs/company/site/jobs'}));
  await started.promise;assert.equal(starts,2);assert.equal(maximum,2);
  release.resolve();await Promise.all(requests);assert.equal(starts,4);assert.equal(maximum,2);
});


test('durable request capacity coordinates separate callers and serializes one board', async (t) => {
  type Lease = { token: string | null; expiresAt: Date | null };
  const store = new Map<string, Lease>();
  const original = { upsert: prisma.providerCircuit.upsert, updateMany: prisma.providerCircuit.updateMany,
    findUnique: prisma.providerCircuit.findUnique };
  t.after(() => { Object.assign(prisma.providerCircuit, original); });
  Object.assign(prisma.providerCircuit, {
    findUnique: async (q: { where: { provider: string } }) => ({
      requestLeaseExpiresAt: store.get(q.where.provider)?.expiresAt || null,
    }),
    upsert: async (q: { where: { provider: string } }) => {
      if (!store.has(q.where.provider)) store.set(q.where.provider, { token: null, expiresAt: null });
      return {};
    },
    updateMany: async (q: { where: { provider: string; requestLeaseToken?: string };
      data: { requestLeaseToken: string | null; requestLeaseExpiresAt: Date | null } }) => {
      const row = store.get(q.where.provider)!;
      if (q.data.requestLeaseToken) {
        if (row.token && row.expiresAt && row.expiresAt > new Date()) return { count: 0 };
      } else if (row.token !== q.where.requestLeaseToken) return { count: 0 };
      row.token = q.data.requestLeaseToken;
      row.expiresAt = q.data.requestLeaseExpiresAt;
      return { count: 1 };
    },
  });
  const release=deferred(), bothStarted=deferred();
  let active=0,maximum=0,starts=0;
  const requests=[0,1,2,0].map(board=>withProviderRequestCapacity('ATS-test-capacity','board-'+board,undefined,async()=>{
    maximum=Math.max(maximum,++active);if(++starts===2)bothStarted.resolve();
    await release.promise;active--;return board;
  }));
  await bothStarted.promise;
  assert.equal(starts,2);
  assert.equal(maximum,2);
  assert.ok(store.get('ATS-test-capacity')?.token);
  assert.ok(store.get('ATS-test-capacity:request-slot:1')?.token);
  release.resolve();
  await Promise.all(requests);
  assert.equal(starts,4);
  assert.equal(maximum,2);
  assert.ok([...store.values()].every(row=>row.token===null));
  // An unknown caller owns both provider slots, not a separate third lane.
  const unknownRelease=deferred(), unknownStarted=deferred();
  const unknown=withProviderRequestCapacity('ATS-test-capacity',null,undefined,async()=>{
    unknownStarted.resolve();await unknownRelease.promise;
  });
  await unknownStarted.promise;
  const cancelled=new AbortController();
  let dispatched=false;
  const waiting=withProviderRequestCapacity('ATS-test-capacity','board-x',cancelled.signal,async()=>{dispatched=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));
  cancelled.abort(new Error('cancel durable waiter'));
  await assert.rejects(waiting,/cancel durable waiter/);
  assert.equal(dispatched,false);
  assert.equal(store.get('board-x')?.token,null);
  unknownRelease.resolve();await unknown;
  assert.ok([...store.values()].every(row=>row.token===null));
});


test('a cooldown published while waiting for capacity defers the queued caller before dispatch', async () => {
  const firstStarted=deferred(), secondStarted=deferred(), firstRelease=deferred(), secondRelease=deferred();
  const options={withCrossProcessLease:async(action:()=>Promise<Response>)=>action(),recordPlatformFailures:false};
  const first=fetchAtsPlatformResponse('hirehive',undefined,async()=>{
    firstStarted.resolve();await firstRelease.promise;return new Response('',{status:429,headers:{'retry-after':'120'}});
  },{...options,requestedUrl:'https://a.hirehive.com/api/v2/jobs',boardSlug:'a'});
  const second=fetchAtsPlatformResponse('hirehive',undefined,async()=>{
    secondStarted.resolve();await secondRelease.promise;return new Response('{}');
  },{...options,requestedUrl:'https://b.hirehive.com/api/v2/jobs',boardSlug:'b'});
  await Promise.all([firstStarted.promise,secondStarted.promise]);
  let dispatched=false;
  const queued=fetchAtsPlatformResponse('hirehive',undefined,async()=>{dispatched=true;return new Response('{}');},
    {...options,requestedUrl:'https://c.hirehive.com/api/v2/jobs',boardSlug:'c'});
  const rejection=assert.rejects(queued,/deferred/);
  await new Promise<void>(resolve=>setImmediate(resolve));
  firstRelease.resolve();await first;await rejection;
  assert.equal(dispatched,false);
  secondRelease.resolve();await second;
  assert.ok(platformPauseRemainingMs('hirehive')>110_000);
});
