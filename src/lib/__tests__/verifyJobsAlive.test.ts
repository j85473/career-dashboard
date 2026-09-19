import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  authoritativeJobVerificationUrl,
  classifyJobPostingLiveness,
  combineAuthoritativeAndPageLiveness,
  verifyInboxJobsAlive,
} from '../verifyJobsAlive';
import { isClosedJobPosting, isTerminalJobPostingPage } from '../jobDescriptionQuality';

test('the Inbox verifier recognizes current closed-posting language', () => {
  const notices = [
    'This position is no longer accepting applications.',
    'The job you’re looking for is no longer available.',
    'This requisition was canceled.',
    'This posting has been removed.',
    'This job has expired.',
    'Applications are no longer being accepted for this job.',
  ];

  for (const notice of notices) {
    assert.equal(isClosedJobPosting(notice), true, notice);
    assert.equal(classifyJobPostingLiveness(200, notice), 'expired', notice);
  }

  assert.equal(isTerminalJobPostingPage('Job not found.'), true);
  assert.equal(classifyJobPostingLiveness(200, 'Job not found.'), 'expired');
});

test('terminal phrases split by page markup are still recognized', () => {
  const html = '<main><h1>This job is no longer <strong>available</strong></h1></main>';
  assert.equal(isTerminalJobPostingPage(html), true);
  assert.equal(classifyJobPostingLiveness(200, html), 'expired');
});

test('script and style text cannot forge closure through malformed end tags', () => {
  const html = [
    '<script>This job is no longer available.</script >',
    '<style>.notice::after { content: "Job not found"; }</style >',
    '<main><h1>Regional Partner Manager</h1><p>Responsibilities include growing partner accounts.</p></main>',
  ].join('');
  assert.equal(isTerminalJobPostingPage(html), false);
  assert.equal(classifyJobPostingLiveness(200, html), 'alive');
});

test('HTTP gone responses expire without relying on page wording', () => {
  assert.equal(classifyJobPostingLiveness(404, ''), 'expired');
  assert.equal(classifyJobPostingLiveness(410, ''), 'expired');
});

test('ATS application shells are verified against their requisition detail endpoints', () => {
  assert.equal(
    authoritativeJobVerificationUrl('https://gartner.wd5.myworkdayjobs.com/en-US/EXT/job/Remote---Texas/Account-Executive_112529-1?source=feed'),
    'https://gartner.wd5.myworkdayjobs.com/wday/cxs/gartner/EXT/job/Remote---Texas/Account-Executive_112529-1',
  );
  assert.equal(
    authoritativeJobVerificationUrl('https://job-boards.greenhouse.io/acme/jobs/12345?gh_src=feed'),
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345',
  );
  assert.equal(
    authoritativeJobVerificationUrl('https://jobs.lever.co/acme/abc-123'),
    'https://api.lever.co/v0/postings/acme/abc-123',
  );
  assert.equal(
    authoritativeJobVerificationUrl('https://apply.workable.com/acme/j/WK-123/'),
    'https://apply.workable.com/api/v1/accounts/acme/jobs/WK-123',
  );
  assert.equal(authoritativeJobVerificationUrl('https://example.com/careers/job/123'), null);
  assert.equal(authoritativeJobVerificationUrl('not a url'), null);
});

test('provider failures and empty success responses stay inconclusive', () => {
  assert.equal(classifyJobPostingLiveness(403, 'Access denied'), 'inconclusive');
  assert.equal(classifyJobPostingLiveness(429, 'Slow down'), 'inconclusive');
  assert.equal(classifyJobPostingLiveness(503, 'Unavailable'), 'inconclusive');
  assert.equal(classifyJobPostingLiveness(204, ''), 'inconclusive');
});

test('an ATS shell cannot overrule an inconclusive requisition endpoint', () => {
  assert.equal(combineAuthoritativeAndPageLiveness('inconclusive', 'alive'), 'inconclusive');
  assert.equal(combineAuthoritativeAndPageLiveness('inconclusive', 'expired'), 'expired');
  assert.equal(combineAuthoritativeAndPageLiveness('alive', 'expired'), 'alive');
  assert.equal(combineAuthoritativeAndPageLiveness('expired', 'alive'), 'expired');
});

test('conditional deadlines and compensation language do not expire a live job', () => {
  const live = `
    Applications will be reviewed until the posting is closed.
    Pay depends on the location in which the position is filled.
    Responsibilities include managing regional partner accounts.
  `;
  assert.equal(isClosedJobPosting(live), false);
  assert.equal(classifyJobPostingLiveness(200, live), 'alive');
});

test('login and cookie walls are not treated as proof that a job closed', () => {
  assert.equal(classifyJobPostingLiveness(200, 'Sign in to apply. Search jobs.'), 'alive');
  assert.equal(classifyJobPostingLiveness(200, 'Manage cookies. Accept all cookies.'), 'alive');
});


test('escaped Workday paths are encoded once and API URLs are not reinterpreted', () => {
  assert.equal(
    authoritativeJobVerificationUrl('https://acme.wd5.myworkdayjobs.com/en-US/External%20Careers/job/US%20Remote/Partner%20Manager_R123'),
    'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External%20Careers/job/US%20Remote/Partner%20Manager_R123',
  );
  assert.equal(
    authoritativeJobVerificationUrl('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/US/Role_R123'),
    null,
  );
  assert.equal(authoritativeJobVerificationUrl('https://acme.myworkdayjobs.com/Careers/job/US/Role%ZZ'), null);
});

test('Lever checks preserve the posting region and do not rewrite API or unrelated hosts', () => {
  assert.equal(
    authoritativeJobVerificationUrl('https://jobs.eu.lever.co/acme/abc-123/apply'),
    'https://api.eu.lever.co/v0/postings/acme/abc-123',
  );
  assert.equal(authoritativeJobVerificationUrl('https://api.lever.co/v0/postings/acme/abc-123'), null);
  assert.equal(authoritativeJobVerificationUrl('https://www.lever.co/blog/example'), null);
});


test('a closure response expires only the unchanged card that was checked', async () => {
  for (const editDuringCheck of [false, true]) {
    const before = new Date('2026-09-17T10:00:00Z');
    const saved = { id: 'edited-job', url: 'https://example.com/old-job', status: 'inbox',
      source: 'ATS-Greenhouse', tailoringStaged: false, updatedAt: before };
    const current = { ...saved };
    let attempts = 0;
    const client = { job: {
      findMany: async () => [{ ...saved }],
      updateMany: async ({ where, data }: Prisma.JobUpdateManyArgs) => {
        attempts++;
        const urlMatches = where?.url === undefined || where.url === current.url;
        const timeMatches = where?.updatedAt === undefined
          || (where.updatedAt instanceof Date && where.updatedAt.valueOf() === current.updatedAt.valueOf());
        const stillMatches = urlMatches && timeMatches;
        if (stillMatches) Object.assign(current, data);
        return { count: stillMatches ? 1 : 0 };
      },
    } } as unknown as Pick<PrismaClient, 'job'>;
    await verifyInboxJobsAlive(undefined, {
      client,
      fetchPosting: async () => {
        if (editDuringCheck) {
          current.url = 'https://example.com/repaired-job';
          current.updatedAt = new Date(before.valueOf() + 1_000);
        }
        return new Response('Job not found', { status: 404 });
      },
    });
    assert.equal(attempts, 1);
    assert.equal(current.status, editDuringCheck ? 'inbox' : 'expired');
  }
});
