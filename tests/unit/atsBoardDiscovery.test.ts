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
    ['Gem', 'gem', 'example', 'https://jobs.gem.com/example/123'],
    ['JobScore', 'jobscore', 'example', 'https://careers.jobscore.com/careers/example/jobs/abc'],
    ['JazzHR', 'jazzhr', 'example', 'https://example.applytojob.com/apply/abc/role'],
    ['Manatal', 'manatal', 'example', 'https://www.careers-page.com/example/job/ABC123'],
    ['HireHive', 'hirehive', 'example', 'https://example.hirehive.com/channel-manager-abc'],
    ['ClearCompany', 'clearcompany', 'adc5441f-f521-a46d-ad4d-ad46a1954fcc', 'https://careers-api.clearcompany.com/v1/adc5441f-f521-a46d-ad4d-ad46a1954fcc'],
    ['Dayforce', 'dayforce', 'mydayforce', 'https://jobs.dayforcehcm.com/en-US/mydayforce/ALLJOBS/jobs/56234'],
    ['Oracle Cloud', 'oracle', 'ehtl.fa.us6.oraclecloud.com::CX', 'https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19195/'],
    ['UKG', 'ukg', 'recruiting2.ultipro.com::dre1001dryg::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b', 'https://recruiting2.ultipro.com/dre1001dryg/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b/OpportunityDetail?opportunityId=728fb6e4-c49c-48f8-9099-28eb36d8a552'],
    ['Comeet', 'comeet', 'port::59.004', 'https://www.comeet.com/jobs/port/59.004/account-manager/F3.27B'],
    ['SuccessFactors', 'successfactors', 'career5.successfactors.eu::C0001122692P::default', 'https://career5.successfactors.eu/career?company=C0001122692P&career_job_req_id=9660'],
    ['Zoho Recruit', 'zohorecruit', 'thinkbridge.zohorecruit.in::Careers', 'https://thinkbridge.zohorecruit.in/jobs/Careers/40078000018949076'],
    ['Eightfold', 'eightfold', 'kraftheinz.eightfold.ai', 'https://kraftheinz.eightfold.ai/careers/job/123'],
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

test('a pasted UKG.net posting learns its full employer board identity', () => {
  const url = 'https://viewsonic.rec.pro.ukg.net/VIE1500VIWO/JobBoard/14152004-90ca-4ccb-b8b0-2df1dfb6e78e/OpportunityDetail?opportunityId=b4775e59-9dbd-4ae3-a21f-515a11f1b0f8';
  assert.deepEqual(discoveredAtsBoardFromJobUrl(url, identifyAts({ url })), {
    platform: 'ukg',
    slug: 'viewsonic.rec.pro.ukg.net::VIE1500VIWO::14152004-90ca-4ccb-b8b0-2df1dfb6e78e',
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
      if (lockIdentity === undefined) lockIdentity = value;
      return 1;
    },
    atsCompany: {
      findMany: async () => [],
      update: async () => { throw new Error('unexpected update'); },
      create: async (args: unknown) => { createArgs = args as { data: Record<string, unknown> }; },
    },
    atsRotationBalanceState: { findUnique: async () => null },
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

test('successful first validation is due immediately without changing the supplied clock', async () => {
  const { firstDiscoveredAtsBoardCheckDate } = await import('../../src/lib/atsBoardDiscovery');
  const now = new Date('2026-10-05T20:00:00.000Z');
  assert.equal(firstDiscoveredAtsBoardCheckDate({ success: true }, now).getTime(), now.getTime());
  assert.equal(now.toISOString(), '2026-10-05T20:00:00.000Z');
  assert.equal(firstDiscoveredAtsBoardCheckDate({ success: false, browserPending: true }, now).getTime(), now.getTime());
  const failedDue = new Date(now);
  failedDue.setDate(failedDue.getDate() + 30);
  assert.equal(firstDiscoveredAtsBoardCheckDate({ success: false }, now).getTime(), failedDue.getTime());
});

test('both Common Crawl producers share the first-collection policy', () => {
  for (const filename of ['src/scripts/discoverATS.ts', 'scripts/audit_ats_common_crawl.ts']) {
    const source = readFileSync(path.join(process.cwd(), filename), 'utf8');
    assert.match(source, /firstDiscoveredAtsBoardCheckDate\(result\)/);
    assert.doesNotMatch(source, /setDate\([^\n]*\+ \(?result\.success \? 1/);
    assert.doesNotMatch(source, /nextCheck\.setDate\(nextCheck\.getDate\(\) \+ 1\)/);
  }
});

test('validation cannot move an existing board schedule or resurrect permanent retirement', async () => {
  for (const status of ['active', 'parked', 'excluded']) {
    const outcome = await recordDiscoveredAtsBoard({
      $executeRaw: async () => 1,
      atsCompany: {
        findMany: async () => [{ slug: 'acme', platform: 'dayforce', status, excludedReason: null }],
        update: async () => { throw new Error('must preserve existing schedule'); },
        create: async () => { throw new Error('must preserve existing board'); },
      },
    } as unknown as Parameters<typeof recordDiscoveredAtsBoard>[0],
    { slug: 'acme', platform: 'dayforce' }, new Date(), { reactivateExisting: false });
    assert.equal(outcome, status === 'excluded' ? 'retired' : 'existing');
  }
});
