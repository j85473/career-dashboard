import assert from 'node:assert/strict';
import test from 'node:test';

import type { DirectAtsMatch } from '../atsDirectMatch';
import type { PostingVerification } from '../jobPostingVerification';
import { verifyJSearchBeforeAim } from '../preAimPostingVerification';
import type { Prisma } from '../prismaClient';

const job = {
  title: 'Channel Account Manager',
  company: 'Acme',
  location: 'Minneapolis, MN',
  description: 'Responsibilities include building partner plans and growing channel revenue.',
  url: 'https://www.jobleads.com/us/job/channel-account-manager--acme--123',
  canonicalUrl: null,
  source: 'JSearch',
};

const employerUrl = 'https://job-boards.greenhouse.io/acme/jobs/12345';
const employerMatch: DirectAtsMatch = {
  url: employerUrl,
  description: job.description,
  platform: 'greenhouse',
  slug: 'acme',
  matchedVia: 'stored',
  matchedBy: 'title',
  postingTitle: job.title,
  postingLocation: job.location,
};
const store = {} as Prisma.TransactionClient;
const result = (liveness: PostingVerification['liveness'], url: string): PostingVerification => ({
  liveness,
  probes: [{ url, status: liveness === 'expired' ? 404 : 200, outcome: liveness, reason: 'test' }],
});

test('a live employer posting repairs an aggregator link before Aim', async () => {
  const checked: string[] = [];
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => employerMatch,
    verify: async posting => {
      checked.push(posting.url);
      return result('alive', posting.url);
    },
  });

  assert.deepEqual(checked, [employerUrl]);
  assert.equal(verification.liveness, 'alive');
  assert.equal(verification.authority, 'employer_posting');
  assert.equal(verification.replacement?.url, employerUrl);
});

test('a closed employer posting wins over an aggregator copy that could still render', async () => {
  const checked: string[] = [];
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => employerMatch,
    verify: async posting => {
      checked.push(posting.url);
      return result('expired', posting.url);
    },
  });

  assert.deepEqual(checked, [employerUrl]);
  assert.equal(verification.liveness, 'expired');
  assert.equal(verification.authority, 'employer_posting');
  assert.equal(verification.replacement, null);
});

test('a live aggregator without an employer match remains eligible but unverified', async () => {
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => null,
    verify: async posting => result('alive', posting.url),
  });

  assert.equal(verification.liveness, 'inconclusive');
  assert.equal(verification.sourceLiveness, 'alive');
  assert.equal(verification.authority, 'unresolved_aggregator');
  assert.equal(verification.replacement, null);
});

test('a confirmed closed source copy expires when no employer posting can be found', async () => {
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => null,
    verify: async posting => result('expired', posting.url),
  });

  assert.equal(verification.liveness, 'expired');
  assert.equal(verification.sourceLiveness, 'expired');
  assert.equal(verification.authority, 'source_copy');
});

test('a recognized employer URL is authoritative and bypasses aggregator resolution', async () => {
  const direct = { ...job, url: employerUrl, canonicalUrl: employerUrl };
  const verification = await verifyJSearchBeforeAim(direct, {
    store,
    resolveCanonical: async () => { throw new Error('direct employer links must not be resolved as aggregators'); },
    verify: async posting => result('alive', posting.url),
  });

  assert.equal(verification.liveness, 'alive');
  assert.equal(verification.authority, 'employer_posting');
  assert.equal(verification.replacement, null);
});

test('employer lookup failures stay inconclusive instead of expiring the job', async () => {
  const verification = await verifyJSearchBeforeAim(job, {
    store,
    resolveCanonical: async () => { throw new Error('catalogue unavailable'); },
    verify: async () => { throw new Error('source should not be treated as authoritative after lookup failure'); },
  });

  assert.equal(verification.liveness, 'inconclusive');
  assert.equal(verification.authority, 'unresolved_aggregator');
});
