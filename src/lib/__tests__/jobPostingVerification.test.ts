import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma, PrismaClient } from '@prisma/client';
import { classifyJobPostingLiveness, verifyJobPosting, isWwrPostingLandingPage } from '../jobPostingVerification';
import { authoritativeJobVerificationUrl, verifyInboxJobsAlive } from '../verifyJobsAlive';

const workday = 'https://epicorsoftware.wd5.myworkdayjobs.com/en-US/epicorjobs/job/US-Remote/Professional-Services-Sales-Architect--Principal_JR104981';
const wwr = 'https://weworkremotely.com/remote-jobs/datadog-principal-partner-manager-channels-gsi-1';
const employer = 'https://careers.datadoghq.com/detail/7582679/?gh_jid=7582679';
const title = 'Principal Partner Manager - Channels (GSI)';
const description = `Responsibilities include managing partner accounts and growing revenue. Qualifications: ten years of channel sales experience. ${'Enable partners, plan business reviews, and develop channel programs. '.repeat(22)}`;
const live = `<main><h1>${title}</h1><p>${description}</p></main>`;

test('Jobilize expired notice with inserted job title and city beats replacement jobs', () => {
  const body = '<div class="alert alert-warning">The <em>Samsung Mobility Channel Manager 24</em> job in <em>all cities</em> has expired, here are the closest matches:</div>' + live;
  assert.equal(classifyJobPostingLiveness(200, body), 'expired');
  assert.equal(classifyJobPostingLiveness(200, '<p>After this job in all cities has expired, contact HR.</p>' + live, title), 'alive');
});

test('Workday redirect widget, cookie walls and Oracle-style shells are inconclusive', () => {
  for (const body of ['{"widget":"redirect","externalSpa":true}', '<title>Careers at Epicor</title><main>Accept Cookies. Search Jobs.</main>', '<main><img alt="Oracle Careers" /></main>', '<main>Checking your browser. Just a moment.</main>']) {
    assert.equal(classifyJobPostingLiveness(200, body, title), 'inconclusive', body);
  }
  assert.equal(classifyJobPostingLiveness(202, live, title), 'inconclusive');
  assert.equal(classifyJobPostingLiveness(200, live, title), 'alive');
  assert.equal(classifyJobPostingLiveness(200, live, 'Different role'), 'inconclusive');
});

test('Workday permission denial uses hydrated closure rather than its shell', async () => {
  const requested: string[] = [];
  const result = await verifyJobPosting({ url: workday, title: 'Principal Consulting Services Territory Manager' }, authoritativeJobVerificationUrl(workday), {
    fetchPosting: async (url, init) => {
      requested.push(String(url));
      assert.equal(new Headers(init?.headers).get('User-Agent'), 'Mozilla/5.0');
      return requested.length === 1 ? new Response('{"errorCode":"S22","message":"permission denied"}', { status: 403 })
        : new Response('{"widget":"redirect","externalSpa":true}');
    },
    readPosting: async url => {
      assert.equal(url, workday);
      return new Response("Title: Careers at Epicor\n\nURL Source: " + workday + "\n\nMarkdown Content:\nAccept cookies.\nThe page you are looking for doesn't exist.");
    },
  });
  assert.equal(result.liveness, 'expired');
  assert.deepEqual(result.probes.map(p => p.outcome), ['inconclusive', 'inconclusive', 'expired']);
});

test('JobLeads reader target-404 is closure; reader-service errors remain uncertainty', async () => {
  const url = 'https://www.jobleads.com/us/job/strategic-retail-account-manager-mass-grocery--minneapolis--ec197b7b6860da5c88b87adf2224089fe';
  const fetchPosting = async () => new Response('Cloudflare', { status: 403 });
  const body = `Title: Strategic Retail Account Manager\n\nURL Source: ${url}\n\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\nThese new jobs might be even better.`;
  assert.equal((await verifyJobPosting({ url, title: 'Strategic Retail Account Manager' }, null, { fetchPosting, readPosting: async () => new Response(body) })).liveness, 'expired');
  for (const status of [404, 410, 429, 503]) {
    assert.equal((await verifyJobPosting({ url, title }, null, { fetchPosting, readPosting: async () => new Response(body, { status }) })).liveness, 'inconclusive');
  }
  assert.equal((await verifyJobPosting({ url, title }, null, { fetchPosting, readPosting: async () => { throw new Error('timeout'); } })).liveness, 'inconclusive');
});

test('WWR posting-to-home/search redirects identify an unavailable source copy', async () => {
  assert.equal(isWwrPostingLandingPage(wwr, 'https://weworkremotely.com/', live), true);
  assert.equal(isWwrPostingLandingPage(wwr, wwr, live), false);
  assert.equal(isWwrPostingLandingPage('https://example.com/job/123', 'https://example.com/', ''), false);
  const body = `Title: We Work Remotely: Advanced Remote Job Search\n\nURL Source: ${wwr}\n\nMarkdown Content:\nSearch for jobs. ${description}`;
  const result = await verifyJobPosting({ url: wwr, title }, null, {
    fetchPosting: async () => new Response('Cloudflare', { status: 403 }), readPosting: async () => new Response(body),
  });
  assert.equal(result.liveness, 'expired');
});

test('a reader target-404 with a complete matching posting preserves the posting', async () => {
  const body = `Title: ${title}\n\nURL Source: ${employer}\n\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\n${description}`;
  const result = await verifyJobPosting({ url: employer, title }, null, {
    fetchPosting: async () => new Response('blocked', { status: 403 }), readPosting: async () => new Response(body),
  });
  assert.equal(result.liveness, 'alive');
  assert.equal((await verifyJobPosting({ url: employer, title }, null, {
    fetchPosting: async () => new Response('blocked', { status: 403 }),
    readPosting: async () => new Response(body.replace(employer, 'https://example.com/other-job')),
  })).liveness, 'inconclusive');
});

function inboxStore() {
  const job = { id: 'card', title, company: 'Datadog', description, url: wwr, canonicalUrl: wwr,
    status: 'inbox', source: 'WeWorkRemotely', sourceId: wwr, tailoringStaged: false,
    updatedAt: new Date('2026-10-01T00:00:00Z'), aimFitScore: 64, reqFitScore: 73, scoringStatus: 'scored',
    batchJobId: null as string | null, jdBatchId: null as string | null };
  const events: unknown[] = [];
  const writes: Prisma.JobUpdateManyArgs[] = [];
  let inTransaction = false;
  const client = { job: {
    findMany: async (args: Prisma.JobFindManyArgs) => {
      assert.equal(args.take, 25);
      assert.equal(args.where?.status, 'inbox');
      assert.equal(args.where?.tailoringStaged, false);
      return [{ ...job }];
    },
    updateMany: async (args: Prisma.JobUpdateManyArgs) => {
      assert.equal(inTransaction, true);
      writes.push(args);
      const { where, data } = args;
      const matches = where?.url === job.url && where?.updatedAt === job.updatedAt
        && where?.status === job.status && where?.tailoringStaged === job.tailoringStaged
        && where?.scoringStatus === job.scoringStatus && where?.batchJobId === job.batchJobId && where?.jdBatchId === job.jdBatchId;
      if (matches) Object.assign(job, data);
      return { count: matches ? 1 : 0 };
    },
  }, jobPipelineEvent: { create: async (event: unknown) => { assert.equal(inTransaction, true); events.push(event); return event; } },
  $transaction: async (persist: (tx: Prisma.TransactionClient) => Promise<number>) => {
    inTransaction = true;
    try { return await persist(client as unknown as Prisma.TransactionClient); } finally { inTransaction = false; }
  } } as unknown as Pick<PrismaClient, 'job' | 'jobPipelineEvent' | '$transaction'>;
  return { client, job, events, writes };
}

test('dead aggregator copy with verified employer posting repairs links and preserves scores', async () => {
  const { client, job, events, writes } = inboxStore();
  await verifyInboxJobsAlive(undefined, { client, delayMs: 0,
    fetchPosting: async url => String(url) === wwr ? new Response('Gone', { status: 410 }) : new Response(live),
    readPosting: async () => { throw new Error('positive employer body should not need rendering'); },
    resolveCanonical: async () => ({ url: employer, description: 'new description must not replace scored evidence', platform: 'unknown', slug: '', matchedVia: 'stored', postingTitle: title, postingLocation: 'Boston, USA' }),
  });
  assert.equal(job.url, employer);
  assert.equal(job.canonicalUrl, employer);
  assert.equal(job.status, 'inbox');
  assert.equal(job.aimFitScore, 64);
  assert.equal(job.reqFitScore, 73);
  assert.equal(job.description, description);
  assert.equal(job.scoringStatus, 'scored');
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['canonicalUrl', 'lastVerifiedAt', 'url']);
  assert.equal(events.length, 1);
});

test('uncertain canonical response preserves Inbox; confirmed dead posting expires', async () => {
  for (const canonical of ['blocked', 'dead', 'none'] as const) {
    const { client, job, events } = inboxStore();
    await verifyInboxJobsAlive(undefined, { client, delayMs: 0,
      fetchPosting: async url => new Response('Unavailable', { status: String(url) === wwr || canonical === 'dead' ? 410 : 403 }),
      readPosting: async () => new Response('Accept cookies.'),
      resolveCanonical: async () => canonical === 'none' ? null : ({ url: employer, description: null, platform: 'unknown', slug: '', matchedVia: 'stored', postingTitle: title, postingLocation: null }),
    });
    assert.equal(job.status, canonical === 'blocked' ? 'inbox' : 'expired');
    assert.equal(job.aimFitScore, 64);
    assert.equal(job.reqFitScore, 73);
    assert.equal(events.length, 1);
  }
});

test('user edits, staging and lifecycle moves defeat stale closure and link repair', async () => {
  for (const repair of [false, true]) {
    for (const action of ['edit', 'stage', 'apply'] as const) {
      const { client, job, events } = inboxStore();
      await verifyInboxJobsAlive(undefined, { client, delayMs: 0,
        fetchPosting: async url => {
          if (String(url) === employer) return new Response(live);
          if (action === 'edit') { job.url = 'https://example.com/repaired'; job.updatedAt = new Date(); }
          if (action === 'stage') job.tailoringStaged = true;
          if (action === 'apply') job.status = 'applied';
          return new Response('Gone', { status: 410 });
        }, resolveCanonical: async () => repair ? ({ url: employer, description: null, platform: 'unknown', slug: '', matchedVia: 'stored', postingTitle: title, postingLocation: null }) : null,
      });
      assert.equal(job.status, action === 'apply' ? 'applied' : 'inbox');
      assert.equal(events.length, 0);
    }
  }
});

test('active JD/local work is never checked, and a new claim defeats an in-flight write', async () => {
  for (const field of ['batchJobId', 'jdBatchId'] as const) {
    const { client, job, events, writes } = inboxStore();
    job[field] = 'lease';
    await verifyInboxJobsAlive(undefined, { client, delayMs: 0, fetchPosting: async () => { throw new Error('leased card must not be fetched'); } });
    assert.equal(writes.length, 0);
    assert.equal(events.length, 0);
    job[field] = null;
    await verifyInboxJobsAlive(undefined, { client, delayMs: 0,
      fetchPosting: async () => { job[field] = 'new-lease'; return new Response('Gone', { status: 410 }); }, resolveCanonical: async () => null,
    });
    assert.equal(job.status, 'inbox');
    assert.equal(events.length, 0);
  }
});
