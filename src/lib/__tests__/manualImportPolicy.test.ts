import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { assessJobDescriptionQuality } from '../jobDescriptionQuality';
import { hasAuthoritativeMetadata } from '../authoritativeMetadataGate';
import { humanLifecycleEvent } from '../jobLifecycleEvents';
import { runLocalHeuristic } from '../jobScoring';
import {
  automatedLifecycleIsProtected,
  manualImportInformationalScoringUpdate,
  MANUAL_IMPORT_INITIAL_LIFECYCLE,
  MANUAL_IMPORT_SOURCE,
  nonManualImportSourceWhere,
  normalizeManualImportMetadata,
} from '../manualImportPolicy';

const LEGRAND_JD = `JOB DESCRIPTION

At a Glance
Legrand has an exciting opportunity for a Strategic IT Channel Development Manager to join the Audio Visual Team. This [emote position reports to Minnetonka, MN.
The Strategic IT Channel Development Manager develops growth strategies across national IT solution providers, technology resellers, and enterprise-focused partners. This role builds scalable partner programs, improves partner engagement, and creates repeatable sales motions across IT-centric accounts.

RESPONSIBILITIES
Develop and execute IT channel growth plans with national solution providers and technology resellers. Create partner-specific business plans with growth objectives, target accounts, enablement needs, sales plays, and measurable success metrics. Lead business reviews with key partners to evaluate performance, pipeline, market opportunities, and collaboration. Develop partner enablement content, training, and sales tools. Monitor partner pipeline and revenue performance. Represent the company at channel events and partner meetings.

QUALIFICATIONS
Strong knowledge of IT channel business models, reseller ecosystems, enterprise technology procurement, and partner-led sales motions. Demonstrated ability to develop channel programs, partner business plans, enablement strategies, and measurable growth initiatives. Minimum of 10 years of experience in IT channel sales, technology reseller management, strategic account development, or related business development. Ability to travel up to 50 percent.`;

const GENERIC = {
  source: MANUAL_IMPORT_SOURCE,
  title: 'Legrand Group Opportunities - Join us',
  company: 'iadugs.fa.ocs.oraclecloud.com',
  location: null,
  description: LEGRAND_JD,
  url: 'https://iadugs.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/751',
};

test('Manual Imports enter Inbox and Tailoring directly', () => {
  assert.deepEqual(MANUAL_IMPORT_INITIAL_LIFECYCLE, {
    status: 'inbox',
    tailoringStaged: true,
  });
});

test('the bounded Legrand JD is scorable and does not belong in JD recovery', () => {
  const quality = assessJobDescriptionQuality(LEGRAND_JD);
  assert.equal(quality.scorable, true);
  assert.deepEqual(quality.signals, {
    hasUsableDuties: true,
    hasUsableQualifications: true,
  });
});

test('anchored Manual Import normalization recovers the exact Legrand metadata', () => {
  const normalized = normalizeManualImportMetadata(GENERIC);
  assert.equal(normalized.title, 'Strategic IT Channel Development Manager');
  assert.equal(normalized.company, 'Legrand');
  assert.equal(normalized.location, 'Remote / Minnetonka, MN');
  assert.deepEqual(normalized.changedFields, ['title', 'company', 'location']);
  assert.equal(normalized.readyForScoring, true);
  assert.equal(normalized.evidence, 'anchored_jd');
});

test('authoritative supplied metadata wins over JD-derived metadata', () => {
  const normalized = normalizeManualImportMetadata({
    ...GENERIC,
    title: 'Authoritative Channel Director',
    company: 'Authoritative Employer',
    location: 'Remote - United States',
  });
  assert.deepEqual(normalized, {
    title: 'Authoritative Channel Director',
    company: 'Authoritative Employer',
    location: 'Remote - United States',
    changedFields: [],
    readyForScoring: true,
    evidence: 'authoritative_metadata',
  });
});

test('normalization fails closed when no anchored company-title sentence exists', () => {
  const normalized = normalizeManualImportMetadata({
    ...GENERIC,
    description: 'Join our team and explore future opportunities.',
  });
  assert.equal(normalized.title, GENERIC.title);
  assert.equal(normalized.company, GENERIC.company);
  assert.equal(normalized.location, null);
  assert.deepEqual(normalized.changedFields, []);
  assert.equal(normalized.readyForScoring, false);
  assert.equal(normalized.evidence, 'unresolved');
});

test('normalizing the Legrand title removes the no-title cap before local scoring', () => {
  const resumes = [{
    name: 'Channel Sales',
    text: 'channel partner management strategic accounts reseller enablement territory growth revenue pipeline',
  }];
  const generic = runLocalHeuristic({
    title: GENERIC.title,
    company: GENERIC.company,
    fullDescription: LEGRAND_JD,
    url: GENERIC.url,
    source: MANUAL_IMPORT_SOURCE,
    manualAts: null,
  }, resumes, []);
  const normalized = normalizeManualImportMetadata(GENERIC);
  const corrected = runLocalHeuristic({
    title: normalized.title,
    company: normalized.company,
    fullDescription: LEGRAND_JD,
    url: GENERIC.url,
    source: MANUAL_IMPORT_SOURCE,
    manualAts: null,
  }, resumes, []);

  assert.equal(generic.gatePass, false);
  assert.match(generic.gateReason, /title signal/i);
  assert.equal(corrected.gatePass, true);
  assert.ok(corrected.score >= 60, `normalized Legrand score was ${corrected.score}`);
});

test('all automated lifecycle outcomes are source-protected for Manual Imports', () => {
  assert.equal(automatedLifecycleIsProtected({ source: MANUAL_IMPORT_SOURCE }), true);
  assert.equal(automatedLifecycleIsProtected({ source: 'ATS-greenhouse' }), false);
  assert.equal(hasAuthoritativeMetadata(MANUAL_IMPORT_SOURCE), false);

  const localScoring = readFileSync(path.join(process.cwd(), 'src/lib/jobScoring.ts'), 'utf8');
  assert.match(localScoring, /isAffirmativelyNonEnglish && !lifecycleProtected/);
  assert.match(localScoring, /hasAuthoritativeMetadata\(scoringJob\.source\) && !lifecycleProtected/);
  assert.match(localScoring, /data: lifecycleProtected\s*\?/);
  assert.match(localScoring, /!filterResult\.passes && !lifecycleProtected/);
  assert.match(localScoring, /const deterministicallyRejected = !triage\.pass && !lifecycleProtected/);
});

test('the Prisma exclusion keeps null and ordinary sources eligible', () => {
  assert.deepEqual(nonManualImportSourceWhere(), {
    OR: [
      { source: null },
      { source: { not: MANUAL_IMPORT_SOURCE } },
    ],
  });
  assert.equal(automatedLifecycleIsProtected({ source: null }), false);
  assert.equal(automatedLifecycleIsProtected({ source: 'ATS-greenhouse' }), false);
  assert.equal(automatedLifecycleIsProtected({ source: MANUAL_IMPORT_SOURCE }), true);
});

test('a protected terminal signal becomes informational instead of skipped or dismissed', () => {
  assert.deepEqual(
    manualImportInformationalScoringUpdate('automated closed-posting signal'),
    {
      scoringStatus: 'scored',
      batchJobId: null,
      jdBatchId: null,
      scoreAttempts: 0,
      scoreError: null,
      fitScore: null,
      fitCategory: 'manual',
      fitRationale: 'Manual Import protection: automated closed-posting signal',
      passReason: null,
    },
  );
});

test('Manual Import route and rescore paths preserve the direct-to-Tailoring contract', () => {
  const manualRoute = readFileSync(path.join(process.cwd(), 'src/app/api/jobs/manual-import/route.ts'), 'utf8');
  const scrapeRoute = readFileSync(path.join(process.cwd(), 'src/app/api/jobs/[id]/scrape/route.ts'), 'utf8');
  const patchRoute = readFileSync(path.join(process.cwd(), 'src/app/api/jobs/[id]/route.ts'), 'utf8');
  assert.match(manualRoute, /MANUAL_IMPORT_INITIAL_LIFECYCLE\.status/);
  assert.match(manualRoute, /MANUAL_IMPORT_INITIAL_LIFECYCLE\.tailoringStaged/);
  assert.match(scrapeRoute, /normalizeManualImportMetadata/);
  assert.match(scrapeRoute, /automatedLifecycleIsProtected\(claimedJob\) \? claimedJob\.status : 'pending_af'/);
  assert.match(patchRoute, /normalizeManualImportMetadata/);
  assert.match(patchRoute, /automatedLifecycleIsProtected\(currentJob\)/);
});

test('an explicit Joseph dismissal remains an authoritative user lifecycle action', () => {
  assert.deepEqual(humanLifecycleEvent('inbox', 'dismissed', 'dismissed'), {
    eventType: 'user_reject',
    enteredInbox: false,
    priorStatus: 'inbox',
    nextStatus: 'dismissed',
    protected: true,
    actor: 'user',
  });
});
