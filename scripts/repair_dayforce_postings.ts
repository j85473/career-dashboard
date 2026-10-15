/**
 * Reconstruct Dayforce postings incorrectly collapsed by shared-host job numbers.
 * Dry-run first; apply only the exact saved plan hash. Original source snapshots
 * and cards are backed up; immutable score events are fingerprinted. Existing
 * scores, JDs and human decisions are never copied, cleared or recomputed.
 *
 * node scripts/with-env.mjs node --import tsx scripts/repair_dayforce_postings.ts --out /private/path
 * ... --apply --plan /private/path/preview-plan.json --selection-hash HASH --out /private/apply-path
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, type Job, type JobSourceObservation } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { dayforcePostingKey, dayforcePostingIdentity } from '../src/lib/dayforcePostingIdentity';
import { passesPreFilter } from '../src/lib/jobFiltering';
import { evaluateAuthoritativeMetadata } from '../src/lib/authoritativeMetadataGate';
import { isScorableJobDescription } from '../src/lib/jobDescriptionQuality';
import { derivePostingFacts } from '../src/lib/postingFacts';
import { sameCompanyIdentity } from '../src/lib/companyIdentity';

type Raw = { id: string; title: string; company: string; description: string; location: string; url: string; createdAt?: string };
type Snapshot = { providerSourceId: string; rawJson: Raw; rawHash: string; observedAt: Date };
type Move = { id: string; from: string; to: string; key: string };
type CardPatch = { id: string; expected: Date; data: Prisma.JobUpdateManyMutationInput };
type RepairPlan = { version: number; patches: CardPatch[]; creates: Prisma.JobCreateManyInput[]; moves: Move[];
  evidence: Array<{ key: string; sourceId: string; rawHash: string }> };
const PREFIX = 'Consolidated after URL edit into job ';
const PELICAN = '3e433be9-965a-4c70-85b5-2752c5995ed7';
const AMPHENOL = '843494fd-7d8e-4789-aadc-5ab1e3a1ebdd';
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const postingHash = (url: string) => {
  const identity = dayforcePostingIdentity(url);
  if (!identity) throw new Error(`Invalid Dayforce posting: ${url}`);
  return `posting:v1:${createHash('sha256').update(`requisition|${identity.host}|${identity.key}`).digest('hex')}`;
};
const chunks = <T>(rows: T[], size = 250): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

export function validateDayforceSnapshot(observation: Pick<JobSourceObservation, 'sourceId' | 'url'>, raw: Raw): boolean {
  return raw?.id === observation.sourceId && Boolean(raw.title?.trim() && raw.company?.trim()
    && raw.description?.trim() && typeof raw.location === 'string')
    && dayforcePostingKey(raw.url) !== null
    && dayforcePostingKey(raw.url) === dayforcePostingKey(observation.url);
}

export function dayforceSnapshotMatchesCard(j: Pick<Job, 'title' | 'company' | 'description'>, raw: Raw): boolean {
  if (normalize(raw.title) !== normalize(j.title)) return false;
  if (sameCompanyIdentity(raw.company, j.company)) return true;
  // An earlier bad source promotion can have replaced the source label and URL
  // while retaining the original JD. Very high text agreement proves the
  // authored job despite variants such as JCB / JCB North America. The caller
  // still requires exactly one matching posting namespace.
  const shingles = (text: string) => {
    const words = normalize(text).split(' ');
    return new Set(words.slice(0, -4).map((_, i) => words.slice(i, i + 5).join(' ')));
  };
  const a = shingles(raw.description), b = shingles(j.description || '');
  const smaller = a.size <= b.size ? a : b, larger = a.size <= b.size ? b : a;
  return smaller.size >= 80 && [...smaller].filter(s => larger.has(s)).length / smaller.size >= 0.95;
}

export function restoredDayforceJob(raw: Raw, observedAt: Date, id: string): Prisma.JobCreateManyInput {
  const filter = passesPreFilter(raw);
  const metadata = evaluateAuthoritativeMetadata(raw);
  const passes = filter.passes && metadata.passes;
  const postedAt = raw.createdAt ? new Date(raw.createdAt) : observedAt;
  return {
    id, title: raw.title, company: raw.company, description: raw.description, location: raw.location,
    url: raw.url, canonicalUrl: raw.url, source: 'ATS-dayforce', sourceId: raw.id,
    postingIdentity: postingHash(raw.url), fingerprint: null,
    postedAt: Number.isNaN(postedAt.getTime()) ? observedAt : postedAt,
    createdAt: observedAt, status: passes ? 'pending_af' : 'archived',
    scoringStatus: passes ? (isScorableJobDescription(raw.description) ? 'queued' : 'needs_jd') : 'skipped',
    passReason: passes ? null : (!filter.passes ? filter.reason : metadata.reason),
    ...derivePostingFacts(raw.description),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => args[args.indexOf(name) + 1];
  if (args.some((arg, i) => !['--out', '--selection-hash', '--apply', '--plan'].includes(arg) && !['--out', '--selection-hash', '--plan'].includes(args[i - 1]))) throw new Error('Unknown argument');
  if (!args.includes('--out')) throw new Error('--out is required (private backup/report directory)');
  const out = resolve(value('--out'));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const apply = args.includes('--apply');
  if (args.includes('--plan')) {
    if (!apply) throw new Error('--plan is only used to apply a reviewed preview');
    const plan: RepairPlan = JSON.parse(readFileSync(resolve(value('--plan')), 'utf8'));
    const selectionHash = hash(plan);
    if (value('--selection-hash') !== selectionHash) throw new Error('Saved plan hash does not match the reviewed selection');
    for (const patch of plan.patches) patch.expected = new Date(patch.expected);
    const creates = new Set(plan.creates.map(j => j.id));
    const ids = [...new Set([...plan.patches.map(p => p.id), ...plan.moves.flatMap(m => [m.from, m.to])])].filter(id => !creates.has(id));
    const jobs: Job[] = [];
    for (const batch of chunks(ids, 1000)) jobs.push(...await prisma.job.findMany({ where: { id: { in: batch } } }));
    const observations: JobSourceObservation[] = [];
    for (const batch of chunks(plan.moves.map(m => m.id), 1000)) observations.push(...await prisma.jobSourceObservation.findMany({ where: { id: { in: batch } } }));
    writeFileSync(`${out}/apply-plan.json`, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
    console.log(`Applying reviewed plan: ${plan.patches.length} existing cards, ${plan.creates.length} restored postings, ${plan.moves.length} source moves`);
    await applyRepair({ plan, jobs, observations, snapshots: [], selectionHash, out });
    return;
  }
  console.log('Loading Dayforce source ownership and existing cards');
  const observations = await prisma.jobSourceObservation.findMany({ where: { source: 'ATS-dayforce' }, orderBy: { id: 'asc' } });
  const byJob = new Map<string, JobSourceObservation[]>();
  for (const o of observations) byJob.set(o.jobId, [...(byJob.get(o.jobId) || []), o]);
  // Include retained consolidated cards even when the merge moved every source
  // away from them. Those cards still own their descriptions and score history.
  const jobs: Job[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page: Job[] = await prisma.job.findMany({ where: { source: 'ATS-dayforce', ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' }, take: 1000 });
    jobs.push(...page);
    if (page.length < 1000) break;
    afterId = page.at(-1)!.id;
  }
  const loadedIds = new Set(jobs.map(j => j.id));
  for (const ids of chunks([...byJob.keys()].filter(id => !loadedIds.has(id)), 1000)) jobs.push(...await prisma.job.findMany({ where: { id: { in: ids } } }));
  // Re-key original aggregator/manual cards with Dayforce links too, even if
  // an ATS board has never attached an observation to them. Otherwise a later
  // arrival could still match their old shared-host identity.
  const alreadyLoaded = new Set(jobs.map(j => j.id));
  const otherDayforceCards = await prisma.job.findMany({ where: { AND: [
    { OR: [{ source: null }, { source: { not: 'ATS-dayforce' } }] },
    { OR: ['https://jobs.dayforcehcm.com/', 'https://jobs.dayforce.com/', 'http://jobs.dayforcehcm.com/', 'http://jobs.dayforce.com/']
      .flatMap(prefix => [{ url: { startsWith: prefix } }, { canonicalUrl: { startsWith: prefix } }]) },
  ] } });
  jobs.push(...otherDayforceCards.filter(j => !alreadyLoaded.has(j.id)));
  const jobsById = new Map(jobs.map(j => [j.id, j]));
  const observationBySourceId = new Map(observations.map(o => [o.sourceId, o]));
  console.log('Checking primary-source metadata for earlier incorrect source promotions');
  const metadata = await prisma.$queryRaw<Array<{ providerSourceId: string; title: string; company: string }>>`
    WITH selected AS MATERIALIZED (
      SELECT DISTINCT ON (o."providerSourceId") o.id FROM "AtsListingObservation" o
      JOIN "AtsIngestionBatch" b ON b.id = o."batchId"
      WHERE b.platform = 'dayforce' AND o."rawJson" IS NOT NULL
      ORDER BY o."providerSourceId", o."observedAt" DESC, o.id DESC
    ) SELECT o."providerSourceId", o."rawJson"->>'title' AS title, o."rawJson"->>'company' AS company
    FROM selected s JOIN "AtsListingObservation" o ON o.id = s.id`;
  const metadataBySource = new Map(metadata.map(m => [m.providerSourceId, m]));
  const suspectJobs = new Set(jobs.filter(j => {
    const m = metadataBySource.get(j.sourceId || '');
    return j.source !== 'ATS-dayforce' || (m && (normalize(m.title) !== normalize(j.title)
      || !sameCompanyIdentity(m.company, j.company)));
  }).map(j => j.id));
  const observationsByKey = new Map<string, JobSourceObservation[]>();
  for (const o of observations) {
    const key = dayforcePostingKey(o.url);
    if (key) observationsByKey.set(key, [...(observationsByKey.get(key) || []), o]);
  }
  const ownKey = new Map<string, string | null>();
  for (const j of jobs) {
    const ownObservation = j.source === 'ATS-dayforce' ? observationBySourceId.get(j.sourceId || '') : undefined;
    ownKey.set(j.id, dayforcePostingKey(ownObservation?.url || j.canonicalUrl || j.url));
  }
  // Aggregator cards can have received an unrelated direct URL during a manual
  // merge. Authored snapshot title + employer, rather than that URL, identifies
  // which of their source observations actually belongs to them.
  const needSnapshots = observations.filter(o => {
    const j = jobsById.get(o.jobId);
    return j && (suspectJobs.has(j.id) || dayforcePostingKey(o.url) !== ownKey.get(o.jobId));
  });
  console.log(`Checking retained listing evidence for ${needSnapshots.length} source observations`);
  const sourceIds = [...new Set(needSnapshots.map(o => o.sourceId))];
  const snapshots = sourceIds.length ? await prisma.$queryRaw<Snapshot[]>`
    WITH selected AS MATERIALIZED (
      SELECT DISTINCT ON (o."providerSourceId") o.id
      FROM "AtsListingObservation" o JOIN "AtsIngestionBatch" b ON b.id = o."batchId"
      JOIN unnest(${sourceIds}::text[]) AS wanted("sourceId") ON wanted."sourceId" = o."providerSourceId"
      WHERE b.platform = 'dayforce' AND o."rawJson" IS NOT NULL
      ORDER BY o."providerSourceId", o."observedAt" DESC, o.id DESC
    )
    SELECT o."providerSourceId", o."rawJson", o."rawHash", o."observedAt"
    FROM selected s JOIN "AtsListingObservation" o ON o.id = s.id
  ` : [];
  const rawBySource = new Map(snapshots.map(s => [s.providerSourceId, s]));
  const held: Array<{ id: string; reason: string }> = [];
  const originalLinkRestores = new Map<string, string>();
  const originalSourceRestores = new Map<string, JobSourceObservation>();
  const correctedSources = new Map<string, Raw>();
  for (const j of jobs.filter(j => suspectJobs.has(j.id))) {
    // Without an ATS observation there is no evidence of a bad source merge.
    // Preserve the existing link and only scope its technical posting identity.
    if (j.source !== 'ATS-dayforce' && !(byJob.get(j.id) || []).length) continue;
    const matchingKeys = new Set((byJob.get(j.id) || []).filter(o => {
      const raw = rawBySource.get(o.sourceId)?.rawJson;
      return raw && validateDayforceSnapshot(o, raw) && dayforceSnapshotMatchesCard(j, raw);
    }).map(o => dayforcePostingKey(o.url)!));
    if (matchingKeys.has(ownKey.get(j.id) || '')) {
      // Retain the original scoped source when its own authored listing agrees.
    } else if (matchingKeys.size === 1) {
      const key = [...matchingKeys][0];
      if (ownKey.get(j.id) !== key && j.source === 'ATS-dayforce') {
        const observation = (byJob.get(j.id) || []).find(o => dayforcePostingKey(o.url) === key)!;
        correctedSources.set(j.id, rawBySource.get(observation.sourceId)!.rawJson);
      }
      ownKey.set(j.id, key);
    }
    else if (matchingKeys.size > 1) {
      // Multiple valid direct reprints are not evidence of a bad merge.
      held.push({ id: j.id, reason: 'multiple_matching_career_sites' });
    } else if (j.source !== 'ATS-dayforce') {
      const original = await prisma.jobSourceObservation.findUnique({ where: { source_sourceId: { source: j.source!, sourceId: j.sourceId! } } });
      if (original?.jobId === j.id && original.url) {
        const originalKey = dayforcePostingKey(original.url);
        if (originalKey) {
          if (originalKey !== ownKey.get(j.id)) originalSourceRestores.set(j.id, original);
          ownKey.set(j.id, originalKey);
        } else { originalLinkRestores.set(j.id, original.url); ownKey.set(j.id, null); }
      } else held.push({ id: j.id, reason: 'no_authored_snapshot_matches_existing_card' });
    } else {
      const m = metadataBySource.get(j.sourceId || '');
      if (m && normalize(m.title) !== normalize(j.title) && !sameCompanyIdentity(m.company, j.company)) {
        const original = await prisma.jobSourceObservation.findFirst({ where: { jobId: j.id, source: { not: 'ATS-dayforce' } }, orderBy: { observedAt: 'asc' } });
        const firstAts = (byJob.get(j.id) || []).reduce((date, o) => o.observedAt < date ? o.observedAt : date, new Date());
        // Source promotion leaves the original discovery receipt intact. Only
        // the receipt recorded when this card was created can restore its
        // source and link; a later reprint is not sufficient authority.
        if (original?.url && original.observedAt < firstAts
          && Math.abs(original.observedAt.getTime() - j.createdAt.getTime()) < 60_000) {
          originalSourceRestores.set(j.id, original);
          ownKey.set(j.id, dayforcePostingKey(original.url));
        } else held.push({ id: j.id, reason: 'primary_source_disagrees_with_original_job' });
      }
    }
  }
  const heldJobs = new Set(held.map(h => h.id));
  const owners = new Map<string, Job[]>();
  for (const j of jobs) {
    const key = ownKey.get(j.id);
    if (key && !heldJobs.has(j.id)) owners.set(key, [...(owners.get(key) || []), j]);
  }
  const owner = new Map<string, Job>();
  for (const [key, cards] of owners) {
    cards.sort((a, b) => Number(['applied', 'interviewing'].includes(b.status)) - Number(['applied', 'interviewing'].includes(a.status))
      || Number(b.aimFitScore !== null || b.reqFitScore !== null) - Number(a.aimFitScore !== null || a.reqFitScore !== null)
      || Number(a.passReason?.startsWith(PREFIX) || false) - Number(b.passReason?.startsWith(PREFIX) || false)
      || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    owner.set(key, cards[0]);
  }
  const grouped = new Map<string, JobSourceObservation[]>();
  for (const o of observations) {
    const key = dayforcePostingKey(o.url);
    if (!key) { held.push({ id: o.id, reason: 'malformed_observation_url' }); continue; }
    if (heldJobs.has(o.jobId) || key === ownKey.get(o.jobId)) continue;
    grouped.set(key, [...(grouped.get(key) || []), o]);
  }
  const creates: Prisma.JobCreateManyInput[] = [];
  const moves: Move[] = [];
  const evidence: Array<{ key: string; sourceId: string; rawHash: string }> = [];
  const stableId = (key: string) => {
    const bytes = createHash('sha256').update(`dayforce-collision-repair-v1|${key}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
    const s = bytes.toString('hex');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
  for (const [key, members] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const verified = members.flatMap(o => {
      const s = rawBySource.get(o.sourceId);
      return s && validateDayforceSnapshot(o, s.rawJson) ? [{ o, s }] : [];
    }).sort((a, b) => b.s.observedAt.getTime() - a.s.observedAt.getTime());
    const target = owner.get(key);
    if (!verified.length) { for (const o of members) held.push({ id: o.id, reason: 'missing_valid_immutable_listing' }); continue; }
    const best = verified[0];
    // Exact client/site/posting identity is authoritative across locale
    // translations and later wording edits. Preserve the existing card's JD.
    const targetId = target?.id || stableId(key);
    if (!target) creates.push(restoredDayforceJob(best.s.rawJson, members.reduce((date, o) => o.observedAt < date ? o.observedAt : date, best.s.observedAt), targetId));
    evidence.push({ key, sourceId: best.o.sourceId, rawHash: best.s.rawHash });
    // Every moved observation has its own immutable evidence; a verified
    // sibling cannot authorize moving an observation with missing evidence.
    for (const { o } of verified) moves.push({ id: o.id, from: o.jobId, to: targetId, key });
    for (const o of members.filter(o => !verified.some(v => v.o.id === o.id))) held.push({ id: o.id, reason: 'missing_valid_immutable_listing' });
  }
  const patches: Array<{ id: string; expected: Date; data: Prisma.JobUpdateManyMutationInput }> = [];
  const badConsolidations = jobs.filter(j => j.passReason?.startsWith(PREFIX)
    && ownKey.get(j.id) && ownKey.get(j.id) !== ownKey.get(j.passReason.slice(PREFIX.length)));
  const mergeEvents = badConsolidations.length ? await prisma.jobPipelineEvent.findMany({
    where: { jobId: { in: badConsolidations.map(j => j.id) }, eventType: 'user_lifecycle' }, orderBy: { occurredAt: 'desc' },
  }) : [];
  for (const j of jobs) {
    const key = ownKey.get(j.id);
    const originalLink = originalLinkRestores.get(j.id);
    const originalSource = originalSourceRestores.get(j.id);
    if (originalSource?.url) {
      patches.push({ id: j.id, expected: j.updatedAt, data: { source: originalSource.source, sourceId: originalSource.sourceId,
        url: originalSource.url, canonicalUrl: originalSource.url, postingIdentity: key ? postingHash(originalSource.url) : null } });
      continue;
    }
    if (originalLink) {
      patches.push({ id: j.id, expected: j.updatedAt, data: { url: originalLink, canonicalUrl: originalLink, postingIdentity: null } });
      continue;
    }
    if (!key || heldJobs.has(j.id)) continue;
    const data: Prisma.JobUpdateManyMutationInput = {};
    const isOwner = owner.get(key)?.id === j.id;
    const observationUrl = observationsByKey.get(key)?.find(o => o.sourceId === j.sourceId)?.url
      || observationsByKey.get(key)?.[0]?.url
      || (dayforcePostingKey(j.canonicalUrl || j.url) === key ? j.canonicalUrl || j.url : null);
    if (!observationUrl) { held.push({ id: j.id, reason: 'own_posting_url_missing' }); continue; }
    const desiredIdentity = isOwner ? postingHash(observationUrl) : null;
    if (j.postingIdentity !== desiredIdentity) data.postingIdentity = desiredIdentity;
    const sourceCorrection = correctedSources.get(j.id);
    if (sourceCorrection) { data.source = 'ATS-dayforce'; data.sourceId = sourceCorrection.id; }
    if (dayforcePostingKey(j.url) !== key && dayforcePostingKey(j.url)) {
      data.url = observationUrl; data.canonicalUrl = observationUrl;
    }
    if (badConsolidations.includes(j)) {
      const event = mergeEvents.find(e => e.jobId === j.id && (e.details as Record<string, unknown>)?.duplicateOfJobId === j.passReason?.slice(PREFIX.length));
      const prior = (event?.details as Record<string, unknown>)?.priorStatus;
      if (typeof prior !== 'string') { held.push({ id: j.id, reason: 'missing_premerge_lifecycle_evidence' }); continue; }
      data.status = prior;
      data.passReason = 'Restored distinct Dayforce posting after incorrect cross-employer consolidation; original decision retained.';
    }
    if (Object.keys(data).length) patches.push({ id: j.id, expected: j.updatedAt, data });
  }
  const pelican = jobsById.get(PELICAN);
  if (!pelican || pelican.status !== 'applied' || pelican.aimFitScore !== 68 || pelican.reqFitScore !== 94) throw new Error('Pelican preservation precondition failed');
  const plan = { version: 1, patches, creates, moves, evidence };
  const selectionHash = hash(plan);
  const summary = { selectionHash, existingCards: jobs.length, identityOrLinkRepairs: patches.length,
    restoredPostings: creates.length, movedObservations: moves.length, held: held.length,
    restoredToQueue: creates.filter(j => j.status === 'pending_af').length,
    restoredOutsideScope: creates.filter(j => j.status === 'archived').length,
    undoneIncorrectMerges: badConsolidations.length, pelicanPatch: patches.find(p => p.id === PELICAN),
    amphenolPatch: patches.find(p => p.id === AMPHENOL), correctedPrimarySources: correctedSources.size,
    restoredOriginalLinks: originalLinkRestores.size, restoredOriginalSources: originalSourceRestores.size,
    jcbPatch: patches.find(p => p.id === '06707006-dc83-4709-b9ed-cf3eca220ee7') };
  const mode = apply ? 'apply' : 'preview';
  writeFileSync(`${out}/${mode}-plan.json`, JSON.stringify(plan), { mode: 0o600 });
  writeFileSync(`${out}/${mode}-summary.json`, JSON.stringify(summary, null, 2), { mode: 0o600 });
  writeFileSync(`${out}/${mode}-held.json`, JSON.stringify(held, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) return;
  if (value('--selection-hash') !== selectionHash) throw new Error('Selection hash changed; review the new preview before applying');
  await applyRepair({ plan, jobs, observations, snapshots, selectionHash, out });
}

async function applyRepair({ plan, jobs, observations, snapshots, selectionHash, out }: {
  plan: RepairPlan; jobs: Job[]; observations: JobSourceObservation[]; snapshots: Snapshot[]; selectionHash: string; out: string;
}) {
  const { patches, creates, moves } = plan;
  const jobsById = new Map(jobs.map(j => [j.id, j]));
  const observationById = new Map(observations.map(o => [o.id, o]));
  const allowed = new Set(['postingIdentity', 'source', 'sourceId', 'url', 'canonicalUrl', 'status', 'passReason']);
  for (const patch of patches) {
    const current = jobsById.get(patch.id);
    if (!current || current.updatedAt.getTime() !== patch.expected.getTime()) throw new Error(`Card changed since preview: ${patch.id}`);
    if (Object.keys(patch.data).some(key => !allowed.has(key))) throw new Error('Repair attempted to change protected card contents');
    if (['applied', 'interviewing'].includes(current.status) && patch.data.status && patch.data.status !== current.status) throw new Error('Repair attempted to change a protected application');
  }
  for (const move of moves) if (observationById.get(move.id)?.jobId !== move.from) throw new Error(`Source changed since preview: ${move.id}`);
  // Back up all affected original records, not only fields being written.
  const affectedIds = new Set([...patches.map(p => p.id), ...moves.map(m => m.from)]);
  // A partial run must resume into a fresh directory; never overwrite the
  // original backup with a snapshot taken after some repairs already committed.
  writeFileSync(`${out}/before-jobs.json`, JSON.stringify(jobs.filter(j => affectedIds.has(j.id))), { mode: 0o600, flag: 'wx' });
  const movedIds = new Set(moves.map(m => m.id));
  writeFileSync(`${out}/before-observations.json`, JSON.stringify(observations.filter(o => movedIds.has(o.id))), { mode: 0o600, flag: 'wx' });
  writeFileSync(`${out}/listing-evidence.json`, JSON.stringify({ references: plan.evidence, snapshots }), { mode: 0o600, flag: 'wx' });
  const beforeScoreEvents = await prisma.$queryRaw<Array<{ fingerprint: string; count: number }>>`
    SELECT md5(string_agg(md5(to_jsonb(e)::text), '' ORDER BY id)) AS fingerprint, COUNT(*)::int AS count FROM "JobScoreEvent" e`;
  writeFileSync(`${out}/before-score-events.json`, JSON.stringify(beforeScoreEvents), { mode: 0o600 });
  const receipt = (data: unknown) => appendFileSync(`${out}/receipts.jsonl`, JSON.stringify(data) + '\n', { mode: 0o600 });
  // Clear only obsolete identity metadata first to release conflicting unique
  // keys. Expected timestamps and row locks prevent overwriting a user edit.
  let cardsDone = 0;
  for (const batch of chunks(patches)) {
    await prisma.$transaction(async tx => {
      const identities = batch.filter(patch => Object.keys(patch.data).length === 1 && 'postingIdentity' in patch.data);
      if (identities.length) {
        const updated = await tx.$executeRaw`
          UPDATE "Job" j SET "postingIdentity" = v.posting
          FROM (VALUES ${Prisma.join(identities.map(patch => Prisma.sql`(${patch.id}, ${patch.data.postingIdentity as string | null}, ${patch.expected.toISOString()}::timestamp)`))}) AS v(id, posting, expected)
          WHERE j.id = v.id AND j."updatedAt" = v.expected`;
        if (updated !== identities.length) throw new Error('Cards changed during identity repair');
      }
      for (const patch of batch.filter(patch => !identities.includes(patch))) {
        const count = await tx.job.updateMany({ where: { id: patch.id, updatedAt: patch.expected },
          data: { ...patch.data, updatedAt: patch.expected } });
        if (count.count !== 1) throw new Error(`Card changed during repair: ${patch.id}`);
      }
      await tx.jobPipelineEvent.createMany({ data: batch.map(patch => ({
        eventKey: `dayforce-card-identity-repair-v1:${selectionHash}:${patch.id}`, jobId: patch.id,
        eventType: 'dayforce_card_identity_repaired', stage: 'ingestion', source: 'ATS-dayforce',
        details: { selectionHash, previousUrl: jobsById.get(patch.id)!.url,
          nextUrl: typeof patch.data.url === 'string' ? patch.data.url : jobsById.get(patch.id)!.url,
          changedFields: Object.keys(patch.data), existingScoresPreserved: true },
      })), skipDuplicates: true });
    }, { timeout: 30_000 });
    receipt({ phase: 'cards', ids: batch.map(p => p.id) });
    cardsDone += batch.length;
    if (cardsDone % 5000 === 0) console.log(`Repaired identity metadata on ${cardsDone}/${patches.length} existing cards`);
  }
  console.log('Existing card identity/link repairs complete; restoring distinct postings');
  const createById = new Map(creates.map(j => [j.id!, j]));
  const movesByTarget = new Map<string, Move[]>();
  for (const move of moves) movesByTarget.set(move.to, [...(movesByTarget.get(move.to) || []), move]);
  let done = 0;
  for (const batch of chunks([...movesByTarget], 100)) {
    await prisma.$transaction(async tx => {
      const newJobs = batch.flatMap(([id]) => createById.has(id) ? [createById.get(id)!] : []);
      if (newJobs.length) await tx.job.createMany({ data: newJobs });
      const batchMoves = batch.flatMap(([, entries]) => entries);
      const updated = await tx.$executeRaw`
        UPDATE "JobSourceObservation" o SET "jobId" = v.target
        FROM (VALUES ${Prisma.join(batchMoves.map(m => Prisma.sql`(${m.id}, ${m.from}, ${m.to})`))}) AS v(id, previous, target)
        WHERE o.id = v.id AND o."jobId" = v.previous`;
      if (updated !== batchMoves.length) throw new Error('Source ownership changed during repair');
      await tx.jobPipelineEvent.createMany({ data: batch.map(([id, entries]) => ({
        eventKey: `dayforce-collision-repair-v1:${id}`, jobId: id, eventType: 'dayforce_identity_repaired',
        stage: 'ingestion', source: 'ATS-dayforce', details: { selectionHash, originalJobIds: [...new Set(entries.map(m => m.from))],
          observationIds: entries.map(m => m.id), restoredFromImmutableListing: createById.has(id), scoresCopied: false },
      })) });
    }, { timeout: 30_000 });
    receipt({ phase: 'sources', ids: batch.map(([id]) => id) });
    done += batch.length;
    if (done % 1000 === 0) console.log(`Restored source ownership for ${done}/${movesByTarget.size} postings`);
  }
  // Verify protected contents of every existing card, not just Pelican.
  const differences: string[] = [];
  const patchById = new Map(patches.map(p => [p.id, p.data]));
  for (const batch of chunks(jobs, 1000)) {
    const after = await prisma.job.findMany({ where: { id: { in: batch.map(j => j.id) } } });
    for (const row of after) {
      const before = jobsById.get(row.id)!;
      const patch = patchById.get(row.id) || {};
      for (const field of ['title', 'company', 'description', 'fitScore', 'aimFitScore', 'reqFitScore', 'fitRationale',
        'reqFitRationale', 'submittedResume', 'tailoringStaged', 'status'] as const) {
        const expected = field === 'status' && typeof patch.status === 'string' ? patch.status : before[field];
        if (row[field] !== expected) differences.push(`${row.id}:${field}`);
      }
    }
  }
  const afterScoreEvents = await prisma.$queryRaw<Array<{ fingerprint: string; count: number }>>`
    SELECT md5(string_agg(md5(to_jsonb(e)::text), '' ORDER BY id)) AS fingerprint, COUNT(*)::int AS count FROM "JobScoreEvent" e`;
  const pelicanAfter = await prisma.job.findUniqueOrThrow({ where: { id: PELICAN } });
  const verification = { differences, beforeScoreEvents, afterScoreEvents,
    scoreEventsUnchanged: JSON.stringify(beforeScoreEvents) === JSON.stringify(afterScoreEvents),
    pelican: { status: pelicanAfter.status, aim: pelicanAfter.aimFitScore, experience: pelicanAfter.reqFitScore, url: pelicanAfter.url },
    completedAt: new Date().toISOString() };
  writeFileSync(`${out}/verification.json`, JSON.stringify(verification, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(verification, null, 2));
  if (differences.length || !verification.scoreEventsUnchanged) throw new Error('Preservation verification requires review');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
