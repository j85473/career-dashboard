import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyJobPosting, isAdpPostingUrl } from '../jobPostingVerification';
import { adpPostingDetailUrl } from '../adpPosting';
import { adpPreScoringDisposition, ADP_APPLICATION_UNAVAILABLE_REASON } from '../adpPreScoring';
import { isRawLocalTerminalFailure } from '../operationalQueue';

const url = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=608a4890-b285-4ecd-8659-69a2d44059f4&ccId=19000101_000001&lang=en_US&jobId=469173';
const title = 'Regional Sales Manager - Fire & Security (NY and NJ)';
const description = 'Responsibilities include managing distributor accounts and growing revenue. Qualifications: five years of channel sales experience. '.repeat(12);
const data = JSON.stringify({ requisitionTitle: title, requisitionDescription: description,
  customFieldGroup: { stringFields: [{ nameCode: { codeValue: 'ExternalJobID' }, stringValue: '469173' }] } });
const shell = '<title>Recruitment</title><div id="app"></div>';
const unavailable = '<div class="recrutiment-career-center-unpublished-message-content"><sdf-alert role="alert">This page is currently not available. Sorry for the inconvenience.</sdf-alert></div>';
const reader = (body: string, source = url) => `Title: Recruitment\n\nURL Source: ${source}\n\nMarkdown Content:\n${body}`;
const fetchRetained = async (target: string | URL) => new Response(String(target) === adpPostingDetailUrl(url) ? data : shell);

test('retained ADP API data never overrides the unavailable applicant-facing page', async () => {
  const result = await verifyJobPosting({ url, title }, null, {
    fetchPosting: fetchRetained,
    readPosting: async () => new Response(reader('This page is currently not available. Sorry for the inconvenience.')),
  });
  assert.equal(result.liveness, 'unavailable');
  assert.deepEqual(result.probes.map(p => p.outcome), ['alive', 'inconclusive', 'unavailable']);
  assert.equal(result.probes.at(-1)?.reason, 'adp_application_page_unavailable');
});

test('ADP unavailable alert is detected on the real DOM response but not as a generic closure', async () => {
  const result = await verifyJobPosting({ url, title }, null, {
    fetchPosting: async target => new Response(String(target) === adpPostingDetailUrl(url) ? data : unavailable),
    readPosting: async () => { throw new Error('The rendered alert is already present'); },
  });
  assert.equal(result.liveness, 'unavailable');
  assert.equal(result.probes.length, 2);
  const other = await verifyJobPosting({ url: 'https://example.com/jobs/1', title }, null, {
    fetchPosting: async () => new Response(unavailable), readPosting: async () => new Response(unavailable),
  });
  assert.equal(other.liveness, 'inconclusive');
});

test('exact ADP requisition 404/410 expires; blocked responses and reader failures do not', async () => {
  for (const status of [404, 410]) {
    const result = await verifyJobPosting({ url, title }, null, {
      fetchPosting: async () => new Response('Gone', { status }),
      readPosting: async () => { throw new Error('Confirmed closure needs no reader'); },
    });
    assert.equal(result.liveness, 'expired');
    assert.equal(result.probes.length, 1);
  }
  for (const status of [403, 429, 503]) {
    const result = await verifyJobPosting({ url, title }, null, {
      fetchPosting: async () => new Response('Access denied', { status }),
      readPosting: async () => new Response(reader('This page is currently not available.'), { status }),
    });
    assert.equal(result.liveness, 'inconclusive');
  }
  assert.equal((await verifyJobPosting({ url, title }, null, {
    fetchPosting: fetchRetained, readPosting: async () => { throw new Error('timeout'); },
  })).liveness, 'inconclusive');
});

test('a live ADP role with generic Recruitment browser title is recognized after rendering', async () => {
  const result = await verifyJobPosting({ url, title }, null, {
    fetchPosting: fetchRetained, readPosting: async () => new Response(reader(`## ${title}\n\n${description}`)),
  });
  assert.equal(result.liveness, 'alive');
  assert.equal((await verifyJobPosting({ url, title }, null, {
    fetchPosting: fetchRetained, readPosting: async () => new Response(reader('This page is currently not available.', url.replace('469173', '111111'))),
  })).liveness, 'inconclusive');
});

test('ADP detail identity, candidate redirects, and real posting bodies prevent false verification', async () => {
  const result = await verifyJobPosting({ url, title }, null, {
    fetchPosting: async target => {
      if (String(target) === adpPostingDetailUrl(url)) return new Response(data.replace('469173', '111111'));
      const response = new Response(unavailable);
      Object.defineProperty(response, 'url', { value: url.replace('469173', '111111') });
      return response;
    },
    readPosting: async () => new Response(reader('Cookie preferences')),
  });
  assert.equal(result.liveness, 'inconclusive');
  assert.equal(result.probes[0].outcome, 'inconclusive');
  assert.equal((await verifyJobPosting({ url, title }, null, {
    fetchPosting: async target => new Response(String(target) === adpPostingDetailUrl(url) ? data : `<h1>${title}</h1><p>${description}</p><p>If this page is currently not available, contact us.</p>`),
  })).liveness, 'alive');
});

test('unavailable new ADP jobs enter Action Needed; confirmed closures expire without writing scores', () => {
  const hold = adpPreScoringDisposition('unavailable', false)!;
  assert.equal(isRawLocalTerminalFailure(hold), true);
  assert.equal(hold.scoreError, ADP_APPLICATION_UNAVAILABLE_REASON);
  assert.equal('status' in hold, false);
  assert.equal(adpPreScoringDisposition('expired', false)?.status, 'expired');
  for (const outcome of ['alive', 'inconclusive'] as const) assert.equal(adpPreScoringDisposition(outcome, false), null);
  for (const outcome of ['alive', 'inconclusive', 'unavailable', 'expired'] as const) assert.equal(adpPreScoringDisposition(outcome, true), null);
  for (const key of Object.keys(hold)) assert(!/^(?:fitScore|aimFitScore|reqFitScore|description)$/.test(key));
});

test('ADP pre-scoring verification is fenced against saved scores, staged work, and edits', () => {
  const source = readFileSync('src/lib/jobScoring.ts', 'utf8');
  const gate = source.slice(source.indexOf('if (!lifecycleProtected && isAdpPostingUrl'), source.indexOf('let resolved: ResolvedDescription;'));
  for (const part of ['claimedJob.fitScore === null', 'prisma.jobScoreEvent.findFirst', 'updatedAt: claimedJob!.updatedAt', 'status: claimedJob!.status', 'scoreEvents: { none: {} }', 'tailoringStaged: false', 'adp_posting_verified']) assert(gate.includes(part), part);
  assert(source.indexOf(gate) < source.indexOf('resolved = await resolveFullDescription(scoringJob)'));
  assert.equal(isAdpPostingUrl(url.replace('https:', 'http:')), false);
  assert.equal(isAdpPostingUrl(url.replace('.com/', '.com.evil.example/')), false);
});
