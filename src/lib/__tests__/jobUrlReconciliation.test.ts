import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job, Prisma } from '@prisma/client';
import {
  CardMergeRefused,
  JobUrlConflict,
  chooseDuplicateCardMergePlan,
  chooseUrlReconciliationPair,
  mergeDuplicateCards,
  reconcileJobUrlEdit,
  urlMetadataConflict,
  urlPostingIdentity,
} from '../jobUrlReconciliation';

const directUrl = 'https://jobs.lever.co/patchmypc/e2d946b2-c0e5-4f58-81a4-fb6ce844a114';
const otherUrl = 'https://jobs.lever.co/patchmypc/360a40b7-9c2a-4bf4-bf6f-55aab18a70ff';
function row(overrides: Partial<Job> = {}): Job {
  return { id: 'copy', title: 'Account Manager, Channel Success', company: 'Patch My PC',
    location: 'United States', status: 'inbox', url: 'https://himalayas.app/companies/patch-my-pc/jobs/account-manager-channel-success',
    canonicalUrl: null, postingIdentity: 'old-source-key', source: 'Himalayas', sourceId: 'original-himalayas-id',
    updatedAt: new Date('2026-09-02T15:50:00Z'), tailoringStaged: false, passReason: null,
    aimFitScore: 88, reqFitScore: 81, scoringStatus: 'scored', description: 'Scored description',
    submittedResume: null, ...overrides } as Job;
}
function fixture(rows: Job[], scoreRows: Array<Record<string, unknown>> = []) {
  const saved = new Map(rows.map(r => [r.id, structuredClone(r)]));
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  const scoreEvents: Array<Record<string, unknown>> = [];
  const movedSources: unknown[] = [];
  const movedAttachments: unknown[] = [];
  let query: unknown;
  const tx = {
    $queryRaw: async () => scoreRows,
    $executeRaw: async () => 0,
    job: {
      findMany: async (args: unknown) => { query = args; return rows.filter(r => r.id !== 'copy'); },
      findUnique: async ({ where }: { where: { id: string } }) => saved.get(where.id),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        writes.push({ id: where.id, data });
        const updated = { ...saved.get(where.id)!, ...data };
        saved.set(where.id, updated);
        return updated;
      },
    },
    jobSourceObservation: {
      updateMany: async (args: unknown) => { movedSources.push(args); return { count: 1 }; },
      upsert: async (args: unknown) => { movedSources.push(args); return {}; },
    },
    jobAttachment: {
      updateMany: async (args: unknown) => { movedAttachments.push(args); return { count: 1 }; },
    },
    jobScoreEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { scoreEvents.push(data); return data; },
    },
    jobPipelineEvent: { upsert: async ({ create }: { create: Record<string, unknown> }) => { events.push(create); return create; } },
  } as unknown as Prisma.TransactionClient;
  return { tx, saved, writes, events, scoreEvents, movedSources, movedAttachments, query: () => query };
}

function scoreRow(input: {
  id: string;
  jobId: string;
  aim: number;
  experience: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    jobId: input.jobId,
    evaluationType: 'standard',
    family: 'legacy',
    aimFitScore: input.aim,
    experienceFitScore: input.experience,
    passed: input.aim > 0,
    staleAt: null,
    staleReason: null,
    schemaVersion: 'career-dashboard-fit-result-v1',
    inputBindings: null,
    sourceAimEventId: null,
    cleanedJdArtifactId: null,
    aimFactualExtractionId: null,
    artifactId: null,
    artifactHash: null,
    artifactStaleAt: null,
    extractionId: null,
    extractionSourceJdHash: null,
    extractionStaleAt: null,
    createdAt: new Date('2026-09-17T12:00:00Z'),
  };
}

test('posting keys equate tracking and apply URLs, but reject boards and distinguish requisitions', () => {
  assert.equal(urlPostingIdentity(directUrl), urlPostingIdentity(`${directUrl}/apply?utm_source=test`));
  assert.notEqual(urlPostingIdentity(directUrl), urlPostingIdentity(otherUrl));
  for (const url of ['https://jobs.lever.co/patchmypc', 'https://example.com/acme2/jobs', 'https://example.com/jobs/view/12345', 'https://example.com/careers', 'javascript:alert(1)']) assert.equal(urlPostingIdentity(url), null);
});

test('an applied match survives spacing differences and retains both records scores and history', async () => {
  const source = row();
  const target = row({ id: 'applied', status: 'applied', company: 'Patchmypc', url: directUrl, canonicalUrl: directUrl,
    postingIdentity: null, submittedResume: 'my-actual-resume.docx', aimFitScore: 92, reqFitScore: 87 });
  const f = fixture([source, target]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.job.id, 'applied');
  assert.equal(result.consolidatedJobId, 'copy');
  assert.equal(f.saved.get('copy')?.status, 'dismissed');
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.submittedResume, target.submittedResume);
  for (const original of [source, target]) {
    const saved = f.saved.get(original.id)!;
    for (const key of ['aimFitScore', 'reqFitScore', 'description', 'scoringStatus'] as const) assert.equal(saved[key], original[key]);
  }
  assert.deepEqual(f.writes.find(w => w.id === 'applied')?.data, { postingIdentity: urlPostingIdentity(directUrl) });
  assert.equal(f.events[0].eventType, 'user_lifecycle');
  assert.equal((f.events[0].details as Record<string, unknown>).duplicateOfJobId, 'applied');
  assert.equal(f.movedSources.length, 2);
  assert.ok(!JSON.stringify(f.query()).includes('createdAt'), 'old applications must remain eligible');
});

test('same URL with conflicting US/UK locations refuses all changes', async () => {
  const source = row();
  const f = fixture([source, row({ id: 'uk', url: otherUrl, location: 'United Kingdom', status: 'archived' })]);
  await assert.rejects(reconcileJobUrlEdit(f.tx, { id: source.id, url: otherUrl, expectedUpdatedAt: source.updatedAt }), (error: unknown) => error instanceof JobUrlConflict && /location is written differently/.test(error.message) && error.mergeTargetJobId !== null);
  assert.equal(f.writes.length, 0);
  assert.equal(f.movedSources.length, 0);
});

test('no matching requisition updates the URL and key without altering scores or lifecycle', async () => {
  const source = row();
  const f = fixture([source, row({ id: 'different', url: otherUrl })]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: `${directUrl}?utm_source=test`, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.consolidatedJobId, null);
  assert.equal(result.job.url, directUrl);
  assert.equal(result.job.canonicalUrl, directUrl);
  assert.equal(result.job.postingIdentity, urlPostingIdentity(directUrl));
  assert.equal(result.job.status, 'inbox');
  assert.equal(result.job.reqFitScore, source.reqFitScore);
});

test('stale edits, ambiguous matches, and protected decisions cannot consolidate', async () => {
  for (const mode of ['stale', 'multiple', 'applied', 'passed', 'cooldown', 'staged', 'combined']) {
    const source = row({ ...(mode === 'staged' ? { tailoringStaged: true } : {}),
      ...(['applied', 'passed', 'cooldown'].includes(mode) ? { status: mode } : {}) });
    const matches = [row({ id: 'target', url: directUrl, status: 'applied' })];
    if (mode === 'multiple') matches.push(row({ id: 'other', url: directUrl }));
    const f = fixture([source, ...matches]);
    await assert.rejects(reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl,
      expectedUpdatedAt: mode === 'stale' ? new Date(0) : source.updatedAt,
      allowConsolidation: mode !== 'combined' }), JobUrlConflict);
    assert.equal(f.writes.length, 0, mode);
  }
});

test('metadata checks tolerate legal employer suffixes but do not guess across titles or locations', () => {
  assert.equal(urlMetadataConflict(row(), row({ company: 'Patchmypc' })), null);
  assert.equal(urlMetadataConflict(row({ company: 'Nilfisk' }), row({ company: 'Nilfisk, Inc.' })), null);
  assert.equal(urlMetadataConflict(row(), row({ title: 'Account Manager, SMB' })), 'job title');
  assert.equal(urlMetadataConflict(row(), row({ company: 'Another employer' })), 'employer');
});

test('only a direct API survivor may treat county and city-state location formats as compatible', () => {
  const source = row({ source: 'Adzuna', location: 'Plymouth, Hennepin County' });
  const reprint = row({ id: 'other-aggregate', source: 'Himalayas', url: directUrl, location: 'Plymouth, MN' });
  assert.equal(
    urlMetadataConflict(source, reprint, { allowDirectAtsLocationCompatibility: false }),
    'location',
  );
  assert.equal(
    urlMetadataConflict(source, reprint, { allowDirectAtsLocationCompatibility: true }),
    null,
  );
});

test('retries return the surviving record without moving history again', async () => {
  const source = row({ status: 'dismissed', passReason: 'Consolidated after URL edit into job target' });
  const f = fixture([source, row({ id: 'target', url: directUrl, status: 'applied' })]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.job.id, 'target');
  assert.equal(f.writes.length, 0);
});

 test('a normal active saved posting can also be the survivor', async () => {
  const source = row();
  const f = fixture([source, row({ id: 'target', url: directUrl, status: 'inbox' })]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.job.id, 'target');
  assert.equal(result.job.status, 'inbox');
  assert.equal(f.saved.get('copy')?.status, 'dismissed');
});

test('a direct ATS/API record becomes canonical and receives an aggregator’s already-applied decision', async () => {
  const aggregate = row({
    id: 'aggregate',
    source: 'Adzuna',
    company: 'Nilfisk Holdings',
    location: 'Plymouth, Hennepin County',
    status: 'passed',
    passReason: 'Already applied',
    aimFitScore: 84,
  });
  const direct = row({
    id: 'direct-api',
    source: 'careerforce',
    sourceId: 'careerforce-id',
    company: 'Nilfisk, Inc.',
    location: 'Plymouth, MN',
    status: 'inbox',
    url: directUrl,
    canonicalUrl: directUrl,
    aimFitScore: 82,
  });
  const f = fixture([aggregate, direct]);

  const result = await reconcileJobUrlEdit(f.tx, {
    id: aggregate.id,
    url: directUrl,
    expectedUpdatedAt: aggregate.updatedAt,
    directMetadata: { company: 'Nilfisk, Inc.', location: 'Plymouth, MN' },
  });

  assert.equal(result.job.id, direct.id);
  assert.equal(result.consolidatedJobId, aggregate.id);
  assert.equal(f.saved.get(aggregate.id)?.status, 'dismissed');
  assert.equal(f.saved.get(direct.id)?.status, 'passed');
  assert.equal(f.saved.get(direct.id)?.passReason, 'Already applied');
  // The lifecycle decision moves; each record retains its own evaluation.
  assert.equal(f.saved.get(aggregate.id)?.aimFitScore, aggregate.aimFitScore);
  assert.equal(f.saved.get(direct.id)?.aimFitScore, direct.aimFitScore);
  assert.equal(f.events.length, 2);
  assert.equal((f.events[0].details as Record<string, unknown>).duplicateOfJobId, direct.id);
  assert.equal((f.events[1].details as Record<string, unknown>).decisionSourceJobId, aggregate.id);
});

test('a scored Inbox record survives a discarded direct ATS duplicate', async () => {
  const aggregate = row({
    id: 'active-scored-aggregate',
    source: 'Jobicy',
    sourceId: '152708',
    status: 'inbox',
    scoringStatus: 'scored',
    aimFitScore: 84,
    reqFitScore: 88,
  });
  const discardedDirect = row({
    id: 'old-direct',
    source: 'ATS-greenhouse',
    sourceId: '8108805',
    status: 'dismissed',
    scoringStatus: 'failed',
    aimFitScore: null,
    reqFitScore: null,
    fitScore: null,
    url: directUrl,
    canonicalUrl: directUrl,
  });
  const f = fixture([aggregate, discardedDirect]);

  const result = await reconcileJobUrlEdit(f.tx, {
    id: aggregate.id,
    url: directUrl,
    expectedUpdatedAt: aggregate.updatedAt,
  });

  assert.equal(result.job.id, aggregate.id);
  assert.equal(result.job.status, 'inbox');
  assert.equal(result.job.aimFitScore, 84);
  assert.equal(result.job.reqFitScore, 88);
  assert.equal(result.job.url, directUrl);
  assert.equal(result.job.canonicalUrl, directUrl);
  assert.equal(result.job.postingIdentity, urlPostingIdentity(directUrl));
  assert.equal(f.saved.get(discardedDirect.id)?.status, 'dismissed');
  assert.equal(f.saved.get(discardedDirect.id)?.postingIdentity, null);
  assert.equal(result.consolidatedJobId, discardedDirect.id);
  assert.equal((f.events[0].details as Record<string, unknown>).duplicateOfJobId, aggregate.id);
  assert.equal(f.movedSources.length, 2);
});

test('an unscored Inbox reprint cannot silently revive a discarded direct ATS record', async () => {
  const aggregate = row({
    id: 'unscored-aggregate', source: 'Jobicy', scoringStatus: 'queued',
    aimFitScore: null, reqFitScore: null, fitScore: null,
  });
  const discardedDirect = row({
    id: 'old-direct', source: 'ATS-greenhouse', status: 'dismissed',
    url: directUrl, canonicalUrl: directUrl,
  });

  const f = fixture([aggregate, discardedDirect]);
  await assert.rejects(reconcileJobUrlEdit(f.tx, {
    id: aggregate.id, url: directUrl, expectedUpdatedAt: aggregate.updatedAt,
  }), /saved job marked dismissed/);
  assert.equal(f.writes.length, 0);
});

test('an applied aggregate survives a discarded direct ATS duplicate even without a score', () => {
  const aggregate = row({
    id: 'applied-aggregate', source: 'Jobicy', status: 'applied',
    scoringStatus: 'queued', aimFitScore: null, reqFitScore: null, fitScore: null,
  });
  const discardedDirect = row({
    id: 'old-direct', source: 'ATS-greenhouse', status: 'dismissed',
  });

  const pair = chooseUrlReconciliationPair(aggregate, discardedDirect);
  assert.equal(pair.canonical.id, aggregate.id);
  assert.equal(pair.preservesEditedRecord, true);
});

test('direct source preference never discards a conflicting human decision', async () => {
  const aggregate = row({
    id: 'aggregate', source: 'Adzuna', status: 'interviewing', passReason: null,
  });
  const direct = row({
    id: 'direct-api', source: 'ATS-workday', status: 'passed', passReason: 'Already applied',
    url: directUrl, canonicalUrl: directUrl,
  });
  const f = fixture([aggregate, direct]);
  await assert.rejects(reconcileJobUrlEdit(f.tx, {
    id: aggregate.id, url: directUrl, expectedUpdatedAt: aggregate.updatedAt,
  }), /different saved decisions/);
  assert.equal(f.writes.length, 0);
});

test('a human decision is not moved onto a direct record with a resume in progress', async () => {
  const aggregate = row({
    id: 'aggregate', source: 'Adzuna', status: 'passed', passReason: 'Already applied',
  });
  const direct = row({
    id: 'direct-api', source: 'ATS-workday', tailoringStaged: true,
    url: directUrl, canonicalUrl: directUrl,
  });
  const f = fixture([aggregate, direct]);
  await assert.rejects(reconcileJobUrlEdit(f.tx, {
    id: aggregate.id, url: directUrl, expectedUpdatedAt: aggregate.updatedAt,
  }), /direct record has a staged or submitted resume/);
  assert.equal(f.writes.length, 0);
});

test('direct source preference is limited to direct APIs over aggregators', () => {
  const aggregate = row({ id: 'aggregate', source: 'Adzuna' });
  const direct = row({ id: 'direct-api', source: 'careerforce' });
  const pair = chooseUrlReconciliationPair(aggregate, direct);
  assert.equal(pair.canonical.id, direct.id);
  assert.equal(pair.redundant.id, aggregate.id);
  assert.equal(pair.prefersDirectAts, true);

  const aggregatePair = chooseUrlReconciliationPair(
    aggregate,
    row({ id: 'another-aggregate', source: 'Himalayas' }),
  );
  assert.equal(aggregatePair.canonical.id, 'another-aggregate');
  assert.equal(aggregatePair.prefersDirectAts, false);
});

test('merging a pasted card into the applied original keeps the original and folds the copy away', async () => {
  const pasted = row({ id: 'pasted', source: 'Manual Import', sourceId: null, status: 'inbox', tailoringStaged: true,
    company: 'CoStar Realty Information, Inc.', url: 'https://costar.wd1.myworkdayjobs.com/en-US/CoStarCareers/job/Sales-Associate_R38823',
    aimFitScore: null, reqFitScore: null, scoringStatus: 'needs_jd' });
  const applied = row({ id: 'applied', source: 'Manual Import', status: 'applied', company: 'CoStar',
    url: 'https://careers.costargroup.com/careers/job/446718413336', postingIdentity: null, aimFitScore: 90 });
  const f = fixture([pasted, applied]);
  const result = await mergeDuplicateCards(f.tx, { redundantId: 'pasted', survivorId: 'applied', route: 'paste_link' });
  assert.equal(result.consolidatedJobId, 'pasted');
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.aimFitScore, 90);
  assert.equal(result.job.tailoringStaged, false, 'staging never moves onto an applied card');
  assert.equal(f.saved.get('pasted')?.status, 'dismissed');
  assert.equal(f.saved.get('pasted')?.passReason, 'Consolidated after URL edit into job applied');
  assert.equal(f.saved.get('pasted')?.postingIdentity, null);
  assert.equal(result.job.postingIdentity, urlPostingIdentity(applied.url!), 'the surviving card adopts the exact link identity');
  assert.deepEqual(f.movedAttachments, [{ where: { jobId: 'pasted' }, data: { jobId: 'applied' } }]);
  assert.equal(f.events[0].jobId, 'pasted');
});

test('merging keeps the application card and prefers the employer link', async () => {
  const appliedCopy = row({ id: 'applied-copy', status: 'applied', url: directUrl, postingIdentity: null });
  const open = row({ id: 'open', status: 'inbox', postingIdentity: 'himalayas-key' });
  const f = fixture([appliedCopy, open]);
  const result = await mergeDuplicateCards(f.tx, { redundantId: 'applied-copy', survivorId: 'open', route: 'card_merge' });
  assert.equal(result.job.id, 'applied-copy');
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.url, directUrl);
  assert.equal(f.saved.get('open')?.status, 'dismissed');
});

test('merging keeps protected application work and refuses only two submitted résumés', async () => {
  const applied = row({ id: 'applied', status: 'applied' });
  const passed = row({ id: 'passed', status: 'passed', passReason: 'Not interested' });
  const decisionMerge = await mergeDuplicateCards(
    fixture([applied, passed]).tx,
    { redundantId: 'applied', survivorId: 'passed', route: 'card_merge' },
  );
  assert.equal(decisionMerge.job.id, 'applied');
  assert.equal(decisionMerge.job.status, 'applied');

  const withResume = row({ id: 'resume', submittedResume: 'resume.docx' });
  const resumeMerge = await mergeDuplicateCards(
    fixture([withResume, row({ id: 'other' })]).tx,
    { redundantId: 'resume', survivorId: 'other', route: 'card_merge' },
  );
  assert.equal(resumeMerge.job.id, 'resume');

  await assert.rejects(
    mergeDuplicateCards(
      fixture([withResume, row({ id: 'other', submittedResume: 'other-resume.docx' })]).tx,
      { redundantId: 'resume', survivorId: 'other', route: 'card_merge' },
    ),
    CardMergeRefused,
  );
});

test('focused merge keeps the active Inbox card and averages two positive score sets', () => {
  const plan = chooseDuplicateCardMergePlan([{
    id: 'inbox', status: 'inbox', passReason: null, tailoringStaged: false, submittedResume: null,
    aim: { jobId: 'inbox', eventId: 'aim-inbox', value: 83 },
    experience: { jobId: 'inbox', eventId: 'exp-inbox', value: 84 },
  }, {
    id: 'passed', status: 'passed', passReason: 'Experience mismatch', tailoringStaged: false, submittedResume: null,
    aim: { jobId: 'passed', eventId: 'aim-passed', value: 88 },
    experience: { jobId: 'passed', eventId: 'exp-passed', value: 80 },
  }], 'inbox');

  assert.equal(plan.survivorId, 'inbox');
  assert.equal(plan.redundantId, 'passed');
  assert.equal(plan.survivorStatus, 'inbox');
  assert.deepEqual({ value: plan.aim.value, mode: plan.aim.mode }, { value: 86, mode: 'average' });
  assert.deepEqual({ value: plan.experience.value, mode: plan.experience.mode }, { value: 82, mode: 'average' });
  assert.equal(plan.aim.writeDerivedEvent, true);
  assert.equal(plan.experience.writeDerivedEvent, true);
});

test('confirmed merge writes auditable averaged score events and keeps the Inbox card visible', async () => {
  const inbox = row({ id: 'inbox', status: 'inbox', aimFitScore: 83, reqFitScore: 84 });
  const passed = row({ id: 'passed', status: 'passed', passReason: 'Experience mismatch',
    url: directUrl, postingIdentity: urlPostingIdentity(directUrl), aimFitScore: 88, reqFitScore: 80 });
  const f = fixture([inbox, passed], [
    scoreRow({ id: 'score-inbox', jobId: 'inbox', aim: 83, experience: 84 }),
    scoreRow({ id: 'score-passed', jobId: 'passed', aim: 88, experience: 80 }),
  ]);

  const result = await mergeDuplicateCards(f.tx, {
    redundantId: 'inbox', survivorId: 'passed', route: 'card_merge',
  });

  assert.equal(result.job.id, 'inbox');
  assert.equal(result.job.status, 'inbox');
  assert.equal(result.job.aimFitScore, 86);
  assert.equal(result.job.reqFitScore, 82);
  assert.equal(f.saved.get('passed')?.status, 'dismissed');
  assert.deepEqual(f.scoreEvents.map((event) => event.evaluationType), [
    'duplicate_merge_aim', 'duplicate_merge_experience',
  ]);
  assert.deepEqual(f.scoreEvents.map((event) => event.model), [
    'deterministic-card-merge', 'deterministic-card-merge',
  ]);
  assert.match(String(f.scoreEvents[0].aimReason), /rounded average of 83 and 88/);
  assert.match(String(f.scoreEvents[1].experienceReason), /rounded average of 84 and 80/);
  assert.deepEqual(
    (f.scoreEvents[0].workerProvenance as { sourceEventIds: string[] }).sourceEventIds,
    ['score-inbox', 'score-passed'],
  );
});

test('focused merge carries a dismissed card score onto the active Inbox survivor', () => {
  const plan = chooseDuplicateCardMergePlan([{
    id: 'inbox', status: 'inbox', passReason: null, tailoringStaged: false, submittedResume: null,
    aim: null, experience: null,
  }, {
    id: 'dismissed', status: 'dismissed', passReason: null, tailoringStaged: false, submittedResume: null,
    aim: { jobId: 'dismissed', eventId: 'aim-dismissed', value: 82 }, experience: null,
  }], 'inbox');

  assert.equal(plan.survivorId, 'inbox');
  assert.deepEqual({ value: plan.aim.value, mode: plan.aim.mode }, { value: 82, mode: 'carried' });
  assert.equal(plan.aim.writeDerivedEvent, true);
});

test('a positive duplicate score beats a zero during consolidation', () => {
  const plan = chooseDuplicateCardMergePlan([{
    id: 'inbox', status: 'inbox', passReason: null, tailoringStaged: false, submittedResume: null,
    aim: { jobId: 'inbox', eventId: 'aim-zero', value: 0 }, experience: null,
  }, {
    id: 'dismissed', status: 'dismissed', passReason: null, tailoringStaged: false, submittedResume: null,
    aim: { jobId: 'dismissed', eventId: 'aim-positive', value: 80 }, experience: null,
  }], 'inbox');

  assert.equal(plan.aim.value, 80);
  assert.equal(plan.aim.mode, 'carried');
});

test('a derived Aim score re-wraps the retained Experience score so its authority stays current', () => {
  const plan = chooseDuplicateCardMergePlan([{
    id: 'inbox', status: 'inbox', passReason: null, tailoringStaged: false, submittedResume: null,
    aim: { jobId: 'inbox', eventId: 'aim-inbox', value: 83 },
    experience: { jobId: 'inbox', eventId: 'exp-inbox', value: 84 },
  }, {
    id: 'dismissed', status: 'dismissed', passReason: null, tailoringStaged: false, submittedResume: null,
    aim: { jobId: 'dismissed', eventId: 'aim-dismissed', value: 88 }, experience: null,
  }], 'inbox');

  assert.equal(plan.aim.writeDerivedEvent, true);
  assert.equal(plan.experience.value, 84);
  assert.equal(plan.experience.mode, 'preserved');
  assert.equal(plan.experience.writeDerivedEvent, true);
});
