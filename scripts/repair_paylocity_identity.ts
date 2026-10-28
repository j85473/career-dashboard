/** Explicit, checkpointed repair. Preview first; --apply requires the saved plan. */
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { prisma } from '../src/lib/prisma';
import { paylocityPostingId } from '../src/lib/paylocityPostingIdentity';
import { generatePostingIdentity, ingestExternalJob } from '../src/lib/jobIngestion';
import { browserPostingSourceId, parseBrowserPosting, type BrowserPostingLink } from '../src/lib/browserAtsPosting';
import { previewBrowserAtsListingTitle } from '../src/lib/browserAtsListingFilter';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { readBoundedAtsBody } from '../src/lib/tenantAtsBoards';
import { mergeDuplicateCards, CONSOLIDATED_REASON_PREFIX } from '../src/lib/jobUrlReconciliation';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import type { Job, JobScoreEvent, JobPipelineEvent } from '../src/lib/prismaClient';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { publicPageData } from '../src/lib/browserAtsHttp';
import { evaluateAuthoritativeMetadata } from '../src/lib/authoritativeMetadataGate';
import { isClosedJobPosting } from '../src/lib/jobDescriptionQuality';
import { paylocityRecoveryClosed, paylocityRetryDelayMs } from '../src/lib/paylocityRecovery';

type Candidate = { id: string; jobId: string; sourceId: string; url: string; board: string | null; link: BrowserPostingLink | null };
type Plan = { version: 1; capturedAt: string; hash: string; cards: Job[]; scores: JobScoreEvent[]; decisions: JobPipelineEvent[]; groups: string[][]; candidates: Candidate[] };
const args = process.argv.slice(2), flag = (name: string) => args.includes(name);
const value = (name: string) => args[args.indexOf(name) + 1];
const folder = value('--directory');
if (!flag('--directory') || !folder) throw Error('--directory is required');
fs.mkdirSync(folder, { recursive: true });
const planFile = path.join(folder, 'plan.json'), receiptFile = path.join(folder, 'recovery.jsonl');
const save = (file: string, object: unknown) => { fs.writeFileSync(file + '.tmp', JSON.stringify(object)); fs.renameSync(file + '.tmp', file); };
const digest = (object: unknown) => canonicalJsonSha256(JSON.parse(JSON.stringify(object)));
const summary = (plan: Plan) => ({ cards: plan.cards.length, duplicateGroups: plan.groups, misassignedObservations: plan.candidates.length,
  withSavedTitle: plan.candidates.filter(c => c.link).length, missingBoard: plan.candidates.filter(c => !c.board).length,
  titleFiltered: plan.candidates.filter(c => c.link && previewBrowserAtsListingTitle({ title: c.link.title, titleComplete: c.link.titleVerified }).wouldSkip).length, hash: plan.hash });

async function preview() {
  const cards = await prisma.job.findMany({ where: { OR: [
    { url: { startsWith: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/' } },
    { canonicalUrl: { startsWith: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/' } },
  ] }, orderBy: { id: 'asc' } });
  const observations = await prisma.jobSourceObservation.findMany({ where: { source: 'ATS-paylocity' },
    include: { job: { select: { canonicalUrl: true, url: true } } } });
  const poisoned = observations.filter(o => {
    const observed = paylocityPostingId(o.url), owner = paylocityPostingId(o.job.canonicalUrl || o.job.url);
    return observed && owner && observed !== owner;
  });
  const boardMap = new Map<string, { board: string; links: Map<string, BrowserPostingLink> }>();
  const sweeps = await prisma.atsBrowserSweep.findMany({ where: { platform: 'paylocity' }, select: { slug: true, cursor: true } });
  for (const sweep of sweeps) {
    const cursor = sweep.cursor as { queue?: BrowserPostingLink[] };
    boardMap.set(browserPostingSourceId(sweep.slug, '').split(':')[0], { board: sweep.slug,
      links: new Map((cursor?.queue || []).map((link: BrowserPostingLink) => [link.id, link])) });
  }
  const candidates: Candidate[] = poisoned.map(o => {
    const board = boardMap.get(o.sourceId.split(':')[0]);
    return { id: o.id, jobId: o.jobId, sourceId: o.sourceId, url: o.url!, board: board?.board || null,
      link: board?.links.get(paylocityPostingId(o.url)!) || null };
  });
  const ids = [...new Set([...cards.map(c => c.id), ...poisoned.map(o => o.jobId)])];
  const groups = new Map<string, string[]>();
  for (const card of cards) {
    if (card.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)) continue;
    const id = paylocityPostingId(card.canonicalUrl || card.url);
    if (id) groups.set(id, [...(groups.get(id) || []), card.id]);
  }
  const plan: Plan = { version: 1, capturedAt: new Date().toISOString(), hash: '', cards,
    scores: await prisma.jobScoreEvent.findMany({ where: { jobId: { in: ids } }, orderBy: { id: 'asc' } }),
    decisions: await prisma.jobPipelineEvent.findMany({ where: { jobId: { in: ids }, stage: 'human_decision' }, orderBy: { id: 'asc' } }),
    groups: [...groups.values()].filter(g => g.length > 1), candidates };
  plan.hash = digest({ ...plan, hash: '' });
  save(planFile, plan);
  console.log(JSON.stringify(summary(plan)));
}

async function keys(plan: Plan) {
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('career-dashboard:job-url-edit', 0))`;
    const snapshot = new Map(plan.cards.map(c => [c.id, c]));
    const rows = await tx.job.findMany({ where: { id: { in: [...snapshot.keys()] } }, orderBy: { id: 'asc' } });
    const owners = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      if (row.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)) continue;
      const key = generatePostingIdentity({ url: row.canonicalUrl || row.url });
      if (!key) continue;
      const previous = owners.get(key);
      // Preserve the current staged/application card; otherwise retain the oldest row.
      const rank = (r: typeof row) => r.submittedResume || ['applied', 'interviewing'].includes(r.status) ? 3 : r.tailoringStaged ? 2 : 1;
      if (!previous || rank(row) > rank(previous) || rank(row) === rank(previous) && row.createdAt < previous.createdAt) owners.set(key, row);
    }
    for (const row of rows) {
      const old = snapshot.get(row.id)!;
      if (row.url !== old.url || row.canonicalUrl !== old.canonicalUrl) throw Error('Link changed since preview: ' + row.id);
      // Only keys change; no score, lifecycle, description, or attachment writes.
      if (row.postingIdentity) await tx.job.update({ where: { id: row.id }, data: { postingIdentity: null } });
    }
    for (const [postingIdentity, row] of owners) await tx.job.update({ where: { id: row.id }, data: { postingIdentity } });
  }, { timeout: 30000 });
  console.log(JSON.stringify({ keysRepaired: plan.cards.length }));
}

async function recordOutcome(candidate: Candidate, result: Record<string, unknown>, detach: boolean, destination?: string) {
  await prisma.$transaction(async tx => {
    const observation = await tx.jobSourceObservation.findUnique({ where: { id: candidate.id } });
    if (observation) {
      if (observation.url !== candidate.url) throw Error('Observation changed since preview');
      if (destination) {
        const card = await tx.job.findUniqueOrThrow({ where: { id: destination } });
        if (paylocityPostingId(card.canonicalUrl || card.url) !== paylocityPostingId(candidate.url)) throw Error('Recovered card has the wrong posting');
        await tx.jobSourceObservation.update({ where: { id: candidate.id }, data: { jobId: destination } });
      }
      // Rejected/unavailable observations are retained verbatim in the immutable audit event.
      // They must no longer assert that a different employer's card owns this posting.
      if (detach) await tx.jobSourceObservation.delete({ where: { id: candidate.id } });
    }
    await recordJobPipelineEvent({ eventType: 'paylocity_identity_recovery', stage: 'ingestion', source: 'ATS-paylocity',
      sourceId: candidate.sourceId, jobId: destination || candidate.jobId,
      details: { ...result, originalObservation: observation ? JSON.parse(JSON.stringify(observation)) : null, originalOwner: candidate.jobId, recoveredJobId: destination || null },
      identityParts: ['paylocity-identity-repair-v1', candidate.id] }, tx);
  });
}

async function recover(plan: Plan) {
  // Shared pacing and Retry-After across all four workers, including catalogue reads.
  let nextRequestAt = 0, spacing = 250;
  async function request(url: string): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      while (Date.now() < nextRequestAt) await new Promise(resolve => setTimeout(resolve, nextRequestAt - Date.now()));
      nextRequestAt = Date.now() + spacing;
      const response = await safeExternalFetch(url, { signal: AbortSignal.timeout(15000) });
      if (response.status !== 429) return response;
      spacing = Math.min(2000, Math.max(500, spacing * 2));
      nextRequestAt = Math.max(nextRequestAt, Date.now() + paylocityRetryDelayMs(response.headers.get('retry-after')));
      await response.body?.cancel();
    }
    throw Error('Paylocity rate limited after bounded retries; checkpoint retained');
  }
  type Metadata = { company: string; jobs: Record<string, { title: string; location: string }> };
  const catalogues = new Map<string, Promise<Metadata | null>>();
  const catalogueFile = path.join(folder, 'catalogues.jsonl');
  if (fs.existsSync(catalogueFile)) for (const line of fs.readFileSync(catalogueFile, 'utf8').trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line); catalogues.set(row.board, Promise.resolve(row.metadata));
  }
  function catalogue(board: string | null): Promise<Metadata | null> {
    if (!board) return Promise.resolve(null);
    const cached = catalogues.get(board); if (cached) return cached;
    const pending = (async () => {
      try {
        const response = await request(board);
        if (!response.ok) { await response.body?.cancel(); return null; }
        const html = await readBoundedAtsBody(response, 5 * 1024 * 1024);
        const data = publicPageData(html), $ = cheerio.load(html);
        const company = String(data?.ModuleTitle || '').trim();
        const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const heading = $('#LayoutLogoName').first().text().trim();
        const title = $('title').text().replace(/\s+-\s+Job Opportunities\s*$/i, '').trim();
        if (response.url.toLowerCase().split('?')[0].replace(/\/$/, '') !== board.toLowerCase().replace(/\/$/, '')
          || !company || ![heading,title].some(s => key(s) === key(company))
          || data?.ShowInternal !== false || !Array.isArray(data.Jobs)) return null;
        const jobs: Metadata['jobs'] = {};
        for (const item of data.Jobs) {
          if (!Number.isSafeInteger(item.JobId) || item.IsInternal !== false || typeof item.JobTitle !== 'string') return null;
          // Unknown remote semantics fail open to the detail read.
          const place = item.JobLocation || {};
          const location = typeof item.IsRemote === 'boolean'
            ? String(item.LocationName || place.Country || '').trim() : '';
          jobs[String(item.JobId)] = { title: item.JobTitle, location: item.IsRemote === true ? `Remote; ${location}` : location };
        }
        const metadata = { company, jobs };
        fs.appendFileSync(catalogueFile, JSON.stringify({ board, metadata }) + '\n');
        return metadata;
      } catch { return null; }
    })();
    catalogues.set(board, pending); return pending;
  }
  async function retain(c: Candidate, posting: { id: string; title: string; company: string; location: string; description: string; url: string }, closed = false, filteredReason?: string) {
    let outcome: string;
    if (filteredReason) {
      // The verified metadata has already failed the ordinary admission gate.
      // No fuzzy/description search can add identity evidence to an empty JD.
      // Use the exact global posting number, retaining any existing human work.
      outcome = await prisma.$transaction(async tx => {
        const postingIdentity = generatePostingIdentity({ url: posting.url })!;
        let job = await tx.job.findUnique({ where: { postingIdentity } });
        if (!job) {
          const matches = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Job"
            WHERE lower("canonicalUrl")=lower(${posting.url})
              AND ("passReason" IS NULL OR "passReason" NOT LIKE 'Consolidated after URL edit into job %')
            ORDER BY "createdAt" DESC LIMIT 1`;
          if (matches[0]) job = await tx.job.findUnique({ where: { id: matches[0].id } });
        }
        const found = Boolean(job);
        if (!job) job = await tx.job.create({ data: { title: posting.title, company: posting.company,
          location: posting.location, description: '', url: posting.url, canonicalUrl: posting.url,
          source: 'ATS-paylocity', sourceId: `paylocity-posting:${posting.id}`, postingIdentity,
          postedAt: new Date(plan.capturedAt),
          status: 'archived', scoringStatus: 'skipped', passReason: filteredReason } });
        await tx.jobSourceObservation.upsert({ where: { source_sourceId: { source: 'ATS-paylocity', sourceId: `paylocity-posting:${posting.id}` } },
          update: {}, create: { source: 'ATS-paylocity', sourceId: `paylocity-posting:${posting.id}`, jobId: job.id, url: posting.url,
            ingestionMode: 'paylocity-identity-recovery', queryFamily: 'recovery', geoLane: 'source_posted_location' } });
        if (!found) await recordJobPipelineEvent({ eventType: 'prefilter_rejected', stage: 'ingestion', source: 'ATS-paylocity',
          sourceId: `paylocity-posting:${posting.id}`, jobId: job.id, details: { reason: filteredReason, route: 'paylocity-identity-recovery' },
          identityParts: ['paylocity-identity-recovery', c.id] }, tx);
        return found ? 'duplicate' : 'filtered';
      });
    } else outcome = await ingestExternalJob({ ...posting, source: 'ATS-paylocity', sourceId: c.sourceId,
      ingestionMode: 'paylocity-identity-recovery', queryFamily: 'recovery', geoLane: 'source_posted_location' });
    const rows = await prisma.jobSourceObservation.findMany({ where: { source: 'ATS-paylocity', OR: [
      { sourceId: `paylocity-posting:${posting.id}` }, { sourceId: c.sourceId },
    ] }, include: { job: { select: { id: true, canonicalUrl: true, url: true, status: true, passReason: true } } } });
    const saved = rows.find(row => paylocityPostingId(row.job.canonicalUrl || row.job.url) === posting.id);
    if (!saved) throw Error('Ingestion did not retain the correct posting');
    if (closed && outcome !== 'duplicate') {
      await prisma.job.updateMany({ where: { id: saved.jobId, status: { in: ['pending_af', 'archived'] },
        aimFitScore: null, reqFitScore: null, tailoringStaged: false }, data: { status: 'expired', scoringStatus: 'skipped', passReason: 'Posting confirmed unavailable during Paylocity recovery' } });
    }
    const result = { outcome: closed ? 'expired' : outcome, title: posting.title, company: posting.company,
      jobId: saved.jobId, status: closed ? 'expired' : saved.job.status, reason: saved.job.passReason };
    await recordOutcome(c, result, false, saved.jobId); return result;
  }
  const done = new Set<string>();
  if (fs.existsSync(receiptFile)) for (const line of fs.readFileSync(receiptFile, 'utf8').trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line); if (row.outcome !== 'retry') done.add(row.id);
  }
  const limit = flag('--limit') ? Number(value('--limit')) : Infinity;
  const candidates = plan.candidates.filter(c => !done.has(c.id)).slice(0, limit);
  let position = 0, processed = 0;
  const counts: Record<string, number> = {};
  async function one(c: Candidate) {
    let result: { outcome: string; [key: string]: unknown } = { outcome: 'retry' };
    try {
      const meta = await catalogue(c.board), published = meta?.jobs[paylocityPostingId(c.url)!];
      const title = c.link && previewBrowserAtsListingTitle({ title: c.link.title, titleComplete: c.link.titleVerified });
      const verdict = published && evaluateAuthoritativeMetadata({ ...published, company: meta!.company, url: c.url });
      if (published && verdict && !verdict.passes) {
        result = await retain(c, { ...published, id: paylocityPostingId(c.url)!, company: meta!.company, url: c.url, description: '' }, false, verdict.reason);
      } else if (title?.wouldSkip) {
        result = { outcome: 'filtered_title', title: c.link!.title, reason: title.reason };
        await recordOutcome(c, result, true);
      } else {
        const response = await request(c.url);
        if ([404, 410].includes(response.status)) {
          await response.body?.cancel(); result = { outcome: 'unavailable', httpStatus: response.status };
          if (meta && (published?.title || c.link?.title)) result = await retain(c, { id: paylocityPostingId(c.url)!, title: published?.title || c.link!.title,
            company: meta.company, location: published?.location || '', url: c.url, description: `Posting unavailable: HTTP ${response.status}` }, true);
          else await recordOutcome(c, result, true);
        } else {
          if (!response.ok) { await response.body?.cancel(); throw Error('HTTP ' + response.status); }
          const html = await readBoundedAtsBody(response, 5 * 1024 * 1024);
          const $ = cheerio.load(html);
          $('script,style').remove();
          const body = $('body').text();
          if (paylocityRecoveryClosed(response.url, $('title').text(), body) || isClosedJobPosting(body)) {
            if (meta && (published?.title || c.link?.title)) {
              return finish(c, await retain(c, { id: paylocityPostingId(c.url)!, title: published?.title || c.link!.title,
                company: meta.company, location: published?.location || '', url: c.url, description: body.slice(0,10000) }, true));
            }
            result = { outcome: 'unavailable', reason: 'publisher_confirmed_closed', finalUrl: response.url };
            await recordOutcome(c, result, true); return finish(c, result);
          }
          if (paylocityPostingId(response.url || c.url) !== paylocityPostingId(c.url)) throw Error('Posting redirected away from its identity');
          const link = c.link || { id: paylocityPostingId(c.url)!, title: '', url: c.url };
          const posting = parseBrowserPosting('paylocity', c.board || c.url, link, [{ url: c.url, html, text: $('body').text() }]);
          if (!posting) throw Error('Posting details could not be verified');
          result = await retain(c, posting);
        }
      }
    } catch (error) { result = { outcome: 'retry', error: String(error) }; }
    finish(c, result);
  }
  function finish(c: Candidate, result: { outcome: string; [key: string]: unknown }) {
    fs.appendFileSync(receiptFile, JSON.stringify({ id: c.id, url: c.url, ...result }) + '\n');
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    processed++;
    if (processed % 100 === 0) console.log(JSON.stringify({ processed, total: candidates.length, counts }));
  }
  await Promise.all(Array.from({ length: 4 }, async () => { while (position < candidates.length) await one(candidates[position++]); }));
  console.log(JSON.stringify({ processed, total: candidates.length, counts }));
}

async function consolidate(plan: Plan) {
  for (const group of plan.groups) {
    let survivorId = group.find(id => plan.cards.find(c => c.id === id)?.tailoringStaged) || group[0];
    for (const id of group.filter(id => id !== survivorId)) {
      const current = await prisma.job.findUniqueOrThrow({ where: { id } });
      if (current.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX)) continue;
      const result = await prisma.$transaction(tx => mergeDuplicateCards(tx, { redundantId: id, survivorId, route: 'card_merge', scorePolicy: 'preserve_survivor' }), { timeout: 30000 });
      survivorId = result.job.id;
      console.log(JSON.stringify({ consolidated: result.consolidatedJobId, survivorId }));
    }
  }
}

async function verify(plan: Plan) {
  const cards = await prisma.job.findMany({ where: { id: { in: plan.cards.map(c => c.id) } } });
  for (const old of plan.cards) {
    const now = cards.find(card => card.id === old.id)!;
    for (const key of ['aimFitScore', 'reqFitScore', 'fitScore', 'travelScore', 'submittedResume', 'description'] as const) {
      if (old[key] !== now[key]) throw Error(`Original ${key} changed on ${old.id}`);
    }
  }
  const current = await prisma.jobScoreEvent.findMany({ where: { id: { in: plan.scores.map(s => s.id) } }, orderBy: { id: 'asc' } });
  if (canonicalJsonSha256(JSON.parse(JSON.stringify(current))) !== canonicalJsonSha256(plan.scores)) throw Error('Original score events changed');
  const decisions = await prisma.jobPipelineEvent.findMany({ where: { id: { in: plan.decisions.map(s => s.id) } }, orderBy: { id: 'asc' } });
  if (canonicalJsonSha256(JSON.parse(JSON.stringify(decisions))) !== canonicalJsonSha256(plan.decisions)) throw Error('Original decision events changed');
  const left = await prisma.jobSourceObservation.findMany({ where: { id: { in: plan.candidates.map(c => c.id) } },
    include: { job: { select: { canonicalUrl: true, url: true } } } });
  const mismatches = left.filter(o => paylocityPostingId(o.url) !== paylocityPostingId(o.job.canonicalUrl || o.job.url));
  console.log(JSON.stringify({ preservedScoreEvents: current.length, preservedDecisionEvents: decisions.length, remainingMisassigned: mismatches.length }));
}

async function main() {
  if (flag('--preview')) return preview();
  const plan: Plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (canonicalJsonSha256({ ...plan, hash: '' }) !== plan.hash) throw Error('Plan hash mismatch');
  if (flag('--verify')) return verify(plan);
  if (!flag('--apply') || value('--selection-hash') !== plan.hash) throw Error('--apply requires the preview selection hash');
  if (flag('--keys')) await keys(plan);
  if (flag('--recover')) await recover(plan);
  if (flag('--consolidate')) await consolidate(plan);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
