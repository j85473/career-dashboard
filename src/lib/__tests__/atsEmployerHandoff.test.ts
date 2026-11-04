import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichAtsListingJob, markAtsListingsWithoutDetail, readAtsJobEnrichmentMarker,
  type AtsJobEnrichmentDependencies } from '../atsJobEnrichment';
import { readPublishedAtsPostingEvidence, recoverRetainedAtsEmployerEvidence } from '../atsEmployerRecovery';
import { AtsPlatformDeferredError, requirePublicAtsEmployer } from '../jobIngestion';
import { oraclePostingDetailUrl } from '../oraclePosting';

const now = new Date('2026-11-04T18:00:00Z');
const oracleSlug = 'handoff.fa.us2.oraclecloud.com::CX';
const oracleJob = { title: 'Account Manager', publicAtsPostingId: '123', company: '',
  url: 'https://handoff.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123/' };
const oracleApi = oraclePostingDetailUrl(oracleJob.url)!.href;
const oracleDetail = (company = '') => JSON.stringify({ items: [{ Id: '123', Title: oracleJob.title,
  ExternalDescriptionStr: '<p>Manage accounts.</p>', PrimaryLocation: 'Chicago, IL', LegalEmployer: company }] });
const corporate = 'https://handoff-employer.example/';
const oracleHeader = `<script id="custom-header" type="text/html"><a class="brand-logo" href="${corporate}">Home</a></script>`;
const companyHtml = '<meta property="og:site_name" content="Example Employer">';
const board = '/TENANT/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b';
const ukgSlug = `recruiting2.ultipro.com::TENANT::${board.split('/').at(-1)}`;
const ukgJob = { title: oracleJob.title, publicAtsPostingId: '14ce5fe4-5d06-404d-8583-07a8c01f5bdf', company: '',
  url: `https://recruiting2.ultipro.com${board}/OpportunityDetail?opportunityId=14ce5fe4-5d06-404d-8583-07a8c01f5bdf` };
const ukgHtml = (branding = '') => branding + `<script>new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify({
  Id: ukgJob.publicAtsPostingId, Title: ukgJob.title, Description: '<p>Manage accounts.</p>',
  Locations: [{ LocalizedDescription: 'Chicago, IL' }],
})});</script>`;
const ukgHeader = `<a href="${corporate}"><img data-automation="navbar-large-logo" alt="Default Brand" src="${board}/Styles/GetLargeHeaderLogo"></a>`;

function response(body: string, url: string, status = 200) {
  const result = new Response(body, { status });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function harness(read: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [], budgets: string[] = [], failures: unknown[] = [], signals: AbortSignal[] = [];
  let fenced = false;
  const dependencies: Partial<AtsJobEnrichmentDependencies> = {
    safeExternalFetch: async (target, init) => {
      const url = String(target); calls.push(url);
      assert.equal(fenced, /\.(?:oraclecloud\.com|ultipro\.com)$/.test(new URL(url).hostname),
        'corporate websites must not inherit the ATS provider circuit');
      assert.ok(init?.signal); signals.push(init.signal);
      return read(url);
    },
    fetchPlatformResponse: async (_platform, _signal, request, options) => {
      assert.equal(fenced, false, 'secondary lookups must not nest a provider fence');
      assert.equal(options?.recordPlatformFailures, false);
      fenced = true;
      try { const result = await request(); await options?.onResponse?.(result); return result; }
      finally { fenced = false; }
    },
    reserveProviderBudgetForSource: async source => { budgets.push(source); return { allowed: true }; },
    verifiedBoardEmployer: async () => '',
    recordProviderSuccess: async () => {},
    recordProviderFailure: async failure => { failures.push(failure); },
    createDeferredError: (platform, retryAt) => new AtsPlatformDeferredError(platform, retryAt),
    now: () => now,
  };
  return { dependencies, calls, budgets, failures, signals };
}

async function consumeReady(platform: string, slug: string, raw: typeof oracleJob, enriched: Record<string, unknown>) {
  const marker = readAtsJobEnrichmentMarker(enriched)!;
  const handoff = { ...raw, company: marker.company };
  const before = structuredClone(handoff);
  const result = await recoverRetainedAtsEmployerEvidence(platform, slug, handoff, {
    boardEmployer: async () => assert.fail('a ready handoff must not revisit its board'),
    postingEvidence: async () => assert.fail('a ready handoff must not reread its posting'),
  });
  requirePublicAtsEmployer(platform, result!.company);
  assert.equal(result?.company, marker.company);
  assert.deepEqual(handoff, before);
}

test('Oracle exact detail evidence produces a ready handoff with one request and no consumer recovery', async () => {
  const h = harness(url => { assert.equal(url, oracleApi); return response(oracleDetail('Example Employer'), url); });
  const before = structuredClone(oracleJob);
  const result = await enrichAtsListingJob({ platform: 'oracle', slug: oracleSlug, job: oracleJob, requestTimeoutMs: 1000 }, h.dependencies);
  await consumeReady('oracle', oracleSlug, oracleJob, result);
  assert.deepEqual(h.calls, [oracleApi]);
  assert.deepEqual(h.budgets, ['ATS-oracle', 'ATS-oracle Details']);
  assert.deepEqual(oracleJob, before);
});

test('verified employer evidence can complete a handoff without discarding an existing description', async () => {
  const job = { ...oracleJob, description: 'Full description already retained.' };
  const h = harness(url => response(JSON.stringify({ items: [{ Id: '123', Title: job.title, LegalEmployer: 'Example Employer' }] }), url));
  const result = await enrichAtsListingJob({ platform: 'oracle', slug: oracleSlug, job, requestTimeoutMs: 1000 }, h.dependencies);
  assert.equal(readAtsJobEnrichmentMarker(result)?.description, job.description);
  await consumeReady('oracle', oracleSlug, job, result);
});

test('new Oracle and UKG handoffs use the retained-work evidence reader without duplicate source reads', async () => {
  for (const [platform, slug, job] of [['oracle', oracleSlug, oracleJob], ['ukg', ukgSlug, ukgJob]] as const) {
    const read = (url: string) => response(url === oracleApi ? oracleDetail() : url === corporate ? companyHtml
      : platform === 'oracle' ? oracleHeader : ukgHtml(ukgHeader), url);
    const h = harness(read);
    let started = 0, responded = 0;
    const result = await enrichAtsListingJob({ platform, slug, job, requestTimeoutMs: 1000,
      onRequestStarted: () => { started++; }, onResponseReceived: () => { responded++; } }, h.dependencies);
    const oldEvidence = await readPublishedAtsPostingEvidence(platform, slug, job, { fetchPage: async url => read(url), registry: async () => '' });
    const marker = readAtsJobEnrichmentMarker(result)!;
    assert.deepEqual({ company: marker.company, description: marker.description, location: marker.location }, oldEvidence);
    assert.deepEqual(h.calls, platform === 'oracle' ? [oracleApi, job.url, corporate] : [job.url, corporate]);
    assert.equal(started, h.calls.length); assert.equal(responded, h.calls.length);
    assert.equal(h.budgets.length, h.calls.length * 2);
    assert.ok(h.signals.every(signal => signal === h.signals[0]), 'secondary evidence shares one network deadline');
    await consumeReady(platform, slug, job, result);
  }
});

test('a new Oracle posting survives an unavailable old alias only through the same requisition on the same tenant', async () => {
  const job = { ...oracleJob, url: oracleJob.url.replace('/CX/', '/old-site/') };
  const oldApi = oraclePostingDetailUrl(job.url)!.href;
  const h = harness(url => url === oldApi ? response('', url, 404)
    : url === job.url ? response(oracleHeader, oracleJob.url) : response(oracleDetail('Example Employer'), url));
  const result = await enrichAtsListingJob({ platform: 'oracle', slug: oracleSlug.replace('::CX', '::old-site'), job,
    requestTimeoutMs: 1000 }, h.dependencies);
  assert.equal(readAtsJobEnrichmentMarker(result)?.company, 'Example Employer');
  assert.deepEqual(h.calls, [oldApi, job.url, oracleApi]);
});

test('unresolved employers and malformed identities remain pending without modifying or sealing the saved listing', async () => {
  for (const [platform, slug, job] of [['oracle', oracleSlug, oracleJob], ['ukg', ukgSlug, ukgJob]] as const) {
    for (const raw of [job, { ...job, publicAtsPostingId: 'wrong-id' }]) {
      const before = structuredClone(raw);
      const h = harness(url => response(url === oracleApi ? oracleDetail() : platform === 'oracle' ? '{}' : ukgHtml(), url));
      assert.equal(markAtsListingsWithoutDetail({ platform, slug, jobs: [raw] }, h.dependencies).markedCount, 0);
      await assert.rejects(enrichAtsListingJob({ platform, slug, job: raw, requestTimeoutMs: 1000 }, h.dependencies), error => {
        assert.ok(error instanceof AtsPlatformDeferredError);
        assert.equal(error.retryAt?.getTime(), now.getTime() + 3600_000);
        return true;
      });
      assert.equal(readAtsJobEnrichmentMarker(raw), null);
      assert.deepEqual(raw, before);
      assert.equal(h.failures.length, 0);
      if (raw.publicAtsPostingId === 'wrong-id') assert.equal(h.calls.length, 0);
    }
  }
});

test('provider holds and operator interruption stop the evidence chain without replacing their retry or writing a marker', async () => {
  const retryAt = new Date(now.getTime() + 5 * 60_000);
  for (const stage of ['budget', 'rate-limit', 'abort'] as const) {
    const controller = new AbortController();
    const h = harness(url => {
      if (url === ukgJob.url) return response(ukgHtml(ukgHeader.replace('handoff-employer', `control-${stage}`)), url);
      if (stage === 'abort') { controller.abort(); throw controller.signal.reason; }
      const result = response('', url, 429); result.headers.set('Retry-After', '300'); return result;
    });
    if (stage === 'budget') h.dependencies.reserveProviderBudgetForSource = async () => ({ allowed: false, retryAt });
    await assert.rejects(enrichAtsListingJob({ platform: 'ukg', slug: ukgSlug, job: ukgJob,
      signal: controller.signal, requestTimeoutMs: 1000 }, h.dependencies), error => {
      assert.ok(error instanceof AtsPlatformDeferredError);
      if (stage !== 'abort') assert.equal(error.retryAt?.getTime(), retryAt.getTime());
      return true;
    });
    assert.equal(h.failures.length, 0);
    assert.equal(readAtsJobEnrichmentMarker(ukgJob), null);
    if (stage === 'budget') assert.equal(h.calls.length, 0);
  }
});

test('registry and receipt failures propagate without being classified as missing employer evidence', async () => {
  for (const stage of ['registry', 'request', 'response'] as const) {
    const failure = new Error('database schema unavailable');
    const h = harness(url => response(ukgHtml(), url));
    if (stage === 'registry') h.dependencies.verifiedBoardEmployer = async () => { throw failure; };
    await assert.rejects(enrichAtsListingJob({ platform: 'ukg', slug: ukgSlug, job: ukgJob, requestTimeoutMs: 1000,
      onRequestStarted: () => { if (stage === 'request') throw failure; },
      onResponseReceived: () => { if (stage === 'response') throw failure; } }, h.dependencies), error => error === failure);
    assert.equal(h.failures.length, 0);
    assert.equal(readAtsJobEnrichmentMarker(ukgJob), null);
  }
});

test('a linked corporate website outage cannot poison the shared ATS provider circuit', async () => {
  for (const status of [429, 500, 'network'] as const) {
    const h = harness(url => {
      if (url === ukgJob.url) return response(ukgHtml(ukgHeader.replace('handoff-employer', `outage-${status}`)), url);
      if (status === 'network') throw new TypeError('fetch failed');
      return response('', url, status);
    });
    await assert.rejects(enrichAtsListingJob({ platform: 'ukg', slug: ukgSlug, job: ukgJob, requestTimeoutMs: 1000 }, h.dependencies),
      error => error instanceof AtsPlatformDeferredError);
    assert.equal(h.failures.length, 0);
    assert.equal(h.calls.length, 2);
  }
});

test('the evidence deadline cancels a queued secondary request before another budget or network dispatch', async () => {
  const h = harness(url => response(oracleDetail(), url));
  const coordinate = h.dependencies.fetchPlatformResponse!;
  let turns = 0;
  h.dependencies.fetchPlatformResponse = async (platform, signal, request, options) => {
    if (++turns === 1) return coordinate(platform, signal, request, options);
    assert.ok(signal);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return coordinate(platform, signal, request, options);
  };
  await assert.rejects(enrichAtsListingJob({ platform: 'oracle', slug: oracleSlug, job: oracleJob,
    requestTimeoutMs: 20 }, h.dependencies), error => error instanceof AtsPlatformDeferredError);
  assert.deepEqual(h.calls, [oracleApi]);
  assert.equal(h.budgets.length, 2);
});

test('retained incomplete handoffs can recover a local copy without rewriting their saved marker or source data', async () => {
  const raw = { ...oracleJob, __careerDashboardAtsEnrichment: { version: 1, status: 'unavailable', company: null } };
  const before = structuredClone(raw), calls: string[] = [];
  const expected = { company: 'Example Employer', description: 'Manage accounts.', location: 'Chicago, IL' };
  const result = await recoverRetainedAtsEmployerEvidence('oracle', oracleSlug, raw, {
    boardEmployer: async () => { calls.push('board'); return ''; },
    postingEvidence: async () => { calls.push('posting'); return expected; },
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(calls, ['board', 'posting']);
  assert.deepEqual(raw, before);
});
