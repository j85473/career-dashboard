import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DISCOVERABLE_ATS_PLATFORM_BY_LABEL,
  discoveredAtsBoardFromJobUrl,
  recordDiscoveredAtsBoard,
} from '../../src/lib/atsBoardDiscovery';
import { identifyAts } from '../../src/lib/atsUtils';

test('link-only updates learn every schedulable public ATS board', () => {
  const cases: Array<[string, string, string, string]> = [
    ['Ashby', 'ashby', 'acme', 'https://jobs.ashbyhq.com/acme/abc-123'],
    ['BambooHR', 'bamboohr', 'acme', 'https://acme.bamboohr.com/careers/42'],
    ['Breezy', 'breezy', 'acme', 'https://acme.breezy.hr/p/abc-channel-manager'],
    ['Greenhouse', 'greenhouse', 'acme', 'https://job-boards.greenhouse.io/acme/jobs/5074579007'],
    ['Lever', 'lever', 'acme', 'https://jobs.lever.co/acme/e7bf85c7-642f'],
    ['Personio', 'personio', 'acme', 'https://acme.jobs.personio.de/job/1834171'],
    ['Pinpoint', 'pinpoint', 'acme', 'https://acme.pinpointhq.com/en/postings/caa511ae'],
    ['Recruitee', 'recruitee', 'acme', 'https://acme.recruitee.com/o/channel-manager'],
    ['Rippling', 'rippling', 'acme', 'https://ats.rippling.com/acme/jobs/2f0674e6-f01f'],
    ['SmartRecruiters', 'smartrecruiters', 'AcmeCorp', 'https://jobs.smartrecruiters.com/AcmeCorp/744000'],
    ['Teamtailor', 'teamtailor', 'acme', 'https://acme.teamtailor.com/jobs/8218173-channel-manager'],
    ['Workable', 'workable', 'acme', 'https://apply.workable.com/acme/j/ABC123/'],
    ['Workday', 'workday', 'adobe.wd5::external_experienced', 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/Remote-Oregon/Senior-Corporate-Account-Manager_R163417'],
  ];

  assert.deepEqual(
    [...new Set(Object.values(DISCOVERABLE_ATS_PLATFORM_BY_LABEL))].sort(),
    cases.map(([, platform]) => platform).sort(),
  );
  for (const [label, platform, slug, url] of cases) {
    assert.equal(identifyAts({ url }), label, url);
    assert.deepEqual(discoveredAtsBoardFromJobUrl(url, label), { slug, platform }, url);
  }
  const alternateWorkdayUrl = 'https://wd1.myworkdaysite.com/recruiting/abinbev/USA/job/Riverside/Manager_123';
  assert.equal(identifyAts({ url: alternateWorkdayUrl }), 'Workday');
  assert.deepEqual(discoveredAtsBoardFromJobUrl(alternateWorkdayUrl, 'Workday'), {
    slug: 'abinbev.wd1::USA',
    platform: 'workday',
  });
});

test('board discovery does not reinterpret an unrecognized ATS URL', () => {
  assert.equal(
    discoveredAtsBoardFromJobUrl('https://example.com/jobs/123', 'Unknown'),
    null,
  );
  // An embedded Greenhouse marker identifies the ATS, but not its board token.
  // Link-only discovery must not invent one from the employer's vanity path.
  assert.equal(
    discoveredAtsBoardFromJobUrl('https://example.com/careers/openings?gh_jid=123', 'Greenhouse'),
    null,
  );
  // A Gusto posting URL carries its own UUID, not the parent board UUID.
  // The browser worker learns that relationship from the board page instead.
  assert.equal(
    discoveredAtsBoardFromJobUrl('https://jobs.gusto.com/postings/acme-role-11111111-1111-1111-1111-111111111111', 'Gusto'),
    null,
  );
});

test('a new discovered board is activated with a rotation cohort', async () => {
  const now = new Date('2026-08-27T20:00:00.000Z');
  let createArgs: { data: Record<string, unknown> } | undefined;
  let lockIdentity: unknown;
  const outcome = await recordDiscoveredAtsBoard({
    $executeRaw: async (_strings: TemplateStringsArray, value: unknown) => {
      lockIdentity = value;
      return 1;
    },
    atsCompany: {
      findMany: async () => [],
      update: async () => { throw new Error('unexpected update'); },
      create: async (args: unknown) => { createArgs = args as { data: Record<string, unknown> }; },
    },
  } as unknown as Parameters<typeof recordDiscoveredAtsBoard>[0], {
      slug: 'adobe.wd5::external_experienced',
      platform: 'workday',
  }, now);

  assert.equal(outcome, 'created');
  assert.ok(createArgs);
  assert.equal(createArgs.data.slug, 'adobe.wd5::external_experienced');
  assert.equal(createArgs.data.platform, 'workday');
  assert.equal(createArgs.data.nextCheckDate, now);
  assert.equal(createArgs.data.jobsFound, 1);
  assert.equal(typeof createArgs.data.checkDay, 'number');
  assert.equal(lockIdentity, '["workday","adobe.wd5::external_experienced"]');
  assert.equal(String(lockIdentity).includes('\u0000'), false);
});

test('full Workday detail scraping returns the same shard-aware identity', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/atsApi.ts'), 'utf8');
  assert.match(source, /const boardSlug = boardSlugFromJobUrl\(url, 'workday'\)/);
  assert.match(source, /atsSlug: boardSlug/);
  assert.doesNotMatch(source, /atsSlug: `\$\{tenant\}::\$\{companySite\}`/);
});
