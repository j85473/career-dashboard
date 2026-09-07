import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import { appliedIdentityFingerprint } from '../appliedDuplicateIdentity';
import { resolveInboxAdmission, recordAppliedRepostAdmission } from '../companyCooldown';
import { cooldownReleasePlan } from '../cooldownRecovery';
import { latestUserLifecycleIntent } from '../userLifecycleAuthority';
import { inspectJobLifecycleInvariant, type LifecycleInvariantSnapshot } from '../jobLifecycleInvariant';
import type { AppliedDuplicateAuthorityJob } from '../appliedDuplicatePolicy';

const role = { title: 'Territory Manager', company: 'Acme', location: 'Minneapolis, MN' };
const oldApplication = new Date('2025-01-01T00:00:00Z');
const now = new Date('2026-09-07T12:00:00Z');
function authority(overrides: Partial<AppliedDuplicateAuthorityJob> = {}) {
  return {
    ...role, id: 'original-application', status: 'applied', passReason: null,
    identityFingerprint: appliedIdentityFingerprint(role),
    updatedAt: oldApplication,
    statusHistory: [{ status: 'applied', createdAt: oldApplication }],
    ...overrides,
  };
}

function fixture(authorities = [authority()]) {
  const queries: Prisma.JobFindManyArgs[] = [];
  const events: Array<{ id: string; eventType: string; occurredAt: Date; details: unknown }> = [];
  const store = {
    job: {
      findMany: async (args: Prisma.JobFindManyArgs) => {
        queries.push(args);
        // The real suppression planner still has to verify identity, location,
        // application authority and self-exclusion on these returned records.
        return authorities;
      },
    },
    jobPipelineEvent: {
      upsert: async ({ create }: { create: typeof events[number] }) => {
        events.push(create);
        return create;
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'job' | 'jobPipelineEvent'>;
  const admit = (overrides: Partial<Parameters<typeof resolveInboxAdmission>[0]> = {}) => resolveInboxAdmission({
    ...role, jobId: 'reposted-under-new-id', source: 'ATS-greenhouse', proposedStatus: 'inbox', now, store,
    ...overrides,
  });
  return { store, queries, events, admit };
}

test('a repost under a new ID stays dismissed long after cooldown and ingestion lookback expire', async () => {
  const f = fixture();
  const admission = await f.admit();
  assert.equal(admission.status, 'dismissed');
  assert.equal(admission.cooldownUntil, null);
  assert.equal(admission.authorityJobId, 'original-application');
  assert.equal(admission.passReason, 'Duplicate of a job already applied: Territory Manager at Acme — Minneapolis, MN');
  assert.equal(f.queries.length, 1, 'permanent repost block runs before temporary company cooldown');
  assert.ok(!JSON.stringify(f.queries).includes('createdAt'), 'application lookup has no age cutoff');
});

test('a passing score cannot return an applied repost from expired cooldown to Inbox', async () => {
  const f = fixture();
  const release = cooldownReleasePlan({
    aim: null, experience: null, cleanedArtifact: null, aimExtraction: null,
    legacy: { id: 'score', evaluationType: 'standard', passed: true, staleAt: null },
  } as unknown as Parameters<typeof cooldownReleasePlan>[0]);
  assert.equal(release.status, 'inbox');
  assert.equal(release.queueLocalScoring, false);
  assert.equal((await f.admit({ proposedStatus: release.status })).status, 'dismissed');
});

test('a different city, title, or employer remains eligible after company cooldown expires', async () => {
  for (const change of [
    { location: 'Duluth, MN' }, { title: 'Sales Director' }, { company: 'Other Employer' },
  ]) {
    assert.equal((await fixture().admit(change)).status, 'inbox');
  }
});

test('legacy fingerprints, Interviewing, and explicit Already applied remain application evidence', async () => {
  for (const historical of [
    authority({ identityFingerprint: null, fingerprint: appliedIdentityFingerprint(role) }),
    authority({ status: 'interviewing' }),
    authority({ status: 'passed', passReason: 'Already applied' }),
  ]) {
    assert.equal((await fixture([historical]).admit()).status, 'dismissed');
  }
});

test('ordinary Passed or Cooldown records do not authorize permanent repost suppression', async () => {
  for (const status of ['passed', 'cooldown']) {
    assert.equal((await fixture([authority({ status })]).admit()).status, 'inbox');
  }
});

test('unreliable locations and the original application itself do not create false matches', async () => {
  for (const location of [null, '2 Locations', 'Unknown Location']) {
    assert.equal((await fixture().admit({ location })).status, 'inbox');
  }
  assert.equal((await fixture().admit({ jobId: 'original-application' })).status, 'inbox');
});

test('Manual Imports and transitions outside Inbox bypass the automatic guard', async () => {
  const f = fixture();
  assert.equal((await f.admit({ source: 'Manual Import' })).status, 'inbox');
  assert.equal((await f.admit({ proposedStatus: 'bookmarked' })).status, 'bookmarked');
  assert.equal(f.queries.length, 0);
});

test('a blocked admission records derived application authority so valid passing scores stay honored', async () => {
  const f = fixture();
  const admission = await f.admit();
  await recordAppliedRepostAdmission({ jobId: 'repost', source: 'ATS-greenhouse', admission }, f.store);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0].details, {
    actor: 'user', protected: true, derived: true,
    originDecisionJobId: 'original-application', originDecisionStatus: 'applied',
    duplicateReason: admission.passReason, nextStatus: 'dismissed',
  });
  const snapshot: LifecycleInvariantSnapshot = {
    id: 'repost', status: admission.status, scoringStatus: 'scored', source: 'ATS-greenhouse',
    tailoringStaged: false, aimFitScore: 90, reqFitScore: 85, passReason: admission.passReason!,
    userIntent: latestUserLifecycleIntent(f.events), rawScoreEventCount: 2,
    inOperationalScope: false, operationalCategories: [],
    authority: { kind: 'experience', eventId: 'existing-score', passed: true, score: 85 },
    legacyLocalDecision: false, legacyLocalReasonRecognized: false,
  };
  assert.deepEqual(inspectJobLifecycleInvariant(snapshot), []);
  assert.equal(snapshot.reqFitScore, 85);
  assert.equal(snapshot.authority.eventId, 'existing-score');
});

test('an ordinary admission records no application-derived dismissal', async () => {
  const f = fixture([]);
  const admission = await f.admit();
  await recordAppliedRepostAdmission({ jobId: 'other', source: null, admission }, f.store);
  assert.equal(f.events.length, 0);
});

test('Jobgether cooldown exemption still blocks a repost of an applied job', async () => {
  const recruiterRole = { ...role, company: 'Jobgether' };
  const f = fixture([authority({
    ...recruiterRole, identityFingerprint: appliedIdentityFingerprint(recruiterRole),
  })]);
  const admission = await f.admit(recruiterRole);
  assert.equal(admission.status, 'dismissed');
  assert.equal(admission.authorityJobId, 'original-application');
  assert.match(admission.passReason!, /Duplicate of a job already applied/);
});
