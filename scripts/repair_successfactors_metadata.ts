import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { recoverSuccessFactorsMetadata, successFactorsPostingIdentity, successFactorsEmployerPageMatches, normalizedSuccessFactorsTitle } from '../src/lib/successFactorsPosting';

type Candidate = { id: string; title: string; company: string; employer: string | null; location: string;
  url: string | null; sourceId: string | null; updatedAt: string };
type Proof = { url: string; respondedUrl: string; file: string; sha256: string };
type Entry = { candidate: Candidate; company?: string; location?: string; evidence: Proof[]; error?: string;
  employerWitness?: { url: string; title: string; company: string } };
type Plan = { version: 1; capturedAt: string; entries: Entry[] };
const args = process.argv.slice(2);
const option = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const planPath = resolve(option('--plan') || 'data/runtime/successfactors-metadata-repair.json');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const missing = (s: string | null) => !s?.trim() || /^(unknown(?: company| location)?|n\/a|not specified)$/i.test(s.trim());
const save = (plan: Plan) => {
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath + '.tmp', JSON.stringify(plan)); renameSync(planPath + '.tmp', planPath);
};

async function verifiedMetadata(entry: Entry) {
  const readPage = async (url: string) => {
    const proof = entry.evidence.find(p => p.url === url);
    if (!proof) return '';
    const body = readFileSync(proof.file, 'utf8');
    if (hash(body) !== proof.sha256 || !successFactorsEmployerPageMatches(url, proof.respondedUrl)) throw new Error('Invalid captured evidence');
    return body;
  };
  const url = entry.candidate.url;
  const metadata = url ? await recoverSuccessFactorsMetadata(await readPage(url), url, readPage) : null;
  if (!entry.employerWitness) return metadata;
  const witness = entry.employerWitness;
  const own = url ? successFactorsPostingIdentity(url) : null;
  const other = successFactorsPostingIdentity(witness.url);
  if (!own || !other || own.host !== other.host || own.tenant !== other.tenant) throw new Error('Employer witness is from another board');
  const employer = await recoverSuccessFactorsMetadata(await readPage(witness.url), witness.url, readPage);
  if (!employer || employer.company !== witness.company
    || normalizedSuccessFactorsTitle(employer.title) !== normalizedSuccessFactorsTitle(witness.title)) throw new Error('Employer witness did not replay');
  // A board-scoped witness supplies only the employer. Never copy a sibling's
  // location, description, title or score onto a closed or unavailable posting.
  return { title: entry.candidate.title, company: witness.company,
    location: metadata && normalizedSuccessFactorsTitle(metadata.title) === normalizedSuccessFactorsTitle(entry.candidate.title)
      ? metadata.location : undefined };
}

async function linkEmployers() {
  const plan: Plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const boards = new Map<string, Entry[]>();
  for (const entry of plan.entries.filter(e => e.company && !e.employerWitness)) {
    const key = entry.candidate.sourceId?.split('::').slice(0, -1).join('::');
    if (key) boards.set(key, [...(boards.get(key) || []), entry]);
  }
  let linked = 0;
  for (const entry of plan.entries.filter(e => !e.company && missing(e.candidate.company))) {
    const key = entry.candidate.sourceId?.split('::').slice(0, -1).join('::');
    const witnesses = key ? boards.get(key) : undefined;
    if (!witnesses?.length || new Set(witnesses.map(e => e.company)).size !== 1) continue;
    const witness = witnesses[0];
    if (!witness.candidate.url || !witness.company) continue;
    entry.employerWitness = { url: witness.candidate.url, title: witness.candidate.title, company: witness.company };
    const urls = new Set(entry.evidence.map(p => p.url));
    entry.evidence.push(...witness.evidence.filter(p => !urls.has(p.url)));
    const metadata = await verifiedMetadata(entry);
    entry.company = metadata?.company;
    if (entry.company) linked++;
  }
  save(plan);
  console.log(JSON.stringify({ boardScopedEmployerRecoveries: linked }));
}

async function collect() {
  if (!option('--candidates')) throw new Error('Collection requires an exported --candidates JSON file');
  const candidates: Candidate[] = JSON.parse(readFileSync(resolve(option('--candidates')!), 'utf8'));
  let plan: Plan;
  try { plan = JSON.parse(readFileSync(planPath, 'utf8')); }
  catch { plan = { version: 1, capturedAt: new Date().toISOString(), entries: [] }; }
  const prior = new Map(plan.entries.map(entry => [entry.candidate.id, entry]));
  const done = new Set(plan.entries.filter(entry => !args.includes('--retry-unresolved') || !entry.error).map(entry => entry.candidate.id));
  if (args.includes('--retry-unresolved')) plan.entries = plan.entries.filter(entry => !entry.error);
  mkdirSync(planPath + '.evidence', { recursive: true });
  let offset = 0;
  let stopped = false;
  const remaining = candidates.filter(candidate => !done.has(candidate.id));
  const worker = async () => {
    while (offset < remaining.length && !stopped) {
      const candidate = remaining[offset++];
      const evidence: Proof[] = [...(prior.get(candidate.id)?.evidence || [])];
      try {
        const url = candidate.url;
        if (!url || !successFactorsPostingIdentity(url)) throw new Error('invalid posting identity');
        const readPage = async (target: string) => {
          const captured = evidence.find(proof => proof.url === target);
          if (captured) {
            const body = readFileSync(captured.file, 'utf8');
            if (hash(body) !== captured.sha256) throw new Error('Evidence hash mismatch');
            return body;
          }
          const response = await safeExternalFetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
          if (response.status === 429) { stopped = true; throw new Error('HTTP 429; checkpoint retained'); }
          if (!response.ok || !successFactorsEmployerPageMatches(target, response.url || target)) throw new Error(`HTTP ${response.status} or cross-origin redirect`);
          const body = await response.text();
          const file = planPath + '.evidence/' + hash(target) + '-' + hash(body) + '.html';
          writeFileSync(file, body);
          evidence.push({ url: target, respondedUrl: response.url || target, file, sha256: hash(body) });
          return body;
        };
        const metadata = await recoverSuccessFactorsMetadata(await readPage(url), url, readPage);
        if (!metadata || normalizedSuccessFactorsTitle(metadata.title) !== normalizedSuccessFactorsTitle(candidate.title)) throw new Error('posting identity or title mismatch');
        plan.entries.push({ candidate, company: missing(candidate.company) ? metadata.company : undefined,
          location: missing(candidate.location) ? metadata.location : undefined, evidence,
          ...((missing(candidate.company) && !metadata.company) || (missing(candidate.location) && !metadata.location)
            ? { error: 'source did not verify all missing fields' } : {}) });
      } catch (error) { plan.entries.push({ candidate, evidence, error: error instanceof Error ? error.message : String(error) }); }
      save(plan);
      if (plan.entries.length % 25 === 0) console.log(JSON.stringify({ inspected: plan.entries.length, total: candidates.length,
        company: plan.entries.filter(entry => entry.company).length, location: plan.entries.filter(entry => entry.location).length }));
      await new Promise(done => setTimeout(done, 300));
    }
  };
  // Four bounded workers; a rate limit stops the pass rather than retrying it.
  await Promise.all(Array.from({ length: 4 }, worker));
  save(plan);
  if (stopped) throw new Error('Source rate limit; run can resume from its checkpoint');
  console.log(JSON.stringify({ inspected: plan.entries.length, company: plan.entries.filter(e => e.company).length,
    location: plan.entries.filter(e => e.location).length, unresolved: plan.entries.filter(e => e.error).length }));
}

async function replay() {
  const plan: Plan = JSON.parse(readFileSync(planPath, 'utf8'));
  for (const entry of plan.entries) {
    if (!entry.candidate.url || !entry.evidence.length) continue;
    const readPage = async (url: string) => {
      const proof = entry.evidence.find(p => p.url === url);
      if (!proof) return '';
      const body = readFileSync(proof.file, 'utf8');
      if (hash(body) !== proof.sha256) throw new Error('Evidence hash mismatch');
      return body;
    };
    const metadata = entry.employerWitness ? await verifiedMetadata(entry)
      : await recoverSuccessFactorsMetadata(await readPage(entry.candidate.url), entry.candidate.url, readPage);
    delete entry.company; delete entry.location;
    if (metadata && normalizedSuccessFactorsTitle(metadata.title) === normalizedSuccessFactorsTitle(entry.candidate.title)) {
      entry.company = missing(entry.candidate.company) ? metadata.company : undefined;
      entry.location = missing(entry.candidate.location) ? metadata.location : undefined;
      if ((!missing(entry.candidate.company) || metadata.company) && (!missing(entry.candidate.location) || metadata.location)) delete entry.error;
    }
  }
  save(plan);
  console.log(JSON.stringify({ inspected: plan.entries.length, company: plan.entries.filter(e => e.company).length,
    location: plan.entries.filter(e => e.location).length, unresolved: plan.entries.filter(e => e.error).length }));
}

async function apply() {
  const plan: Plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan.version !== 1) throw new Error('Unsupported plan version');
  const { prisma } = await import('../src/lib/prisma');
  const receipts: Array<{ id: string; result: string; company?: string; location?: string }> = [];
  try {
    // Replay the same parser against captured, hash-verified evidence before
    // any write. Collection and application cannot silently disagree.
    for (const entry of plan.entries.filter(e => e.company || e.location)) {
      for (const proof of entry.evidence) {
        if (hash(readFileSync(proof.file, 'utf8')) !== proof.sha256) throw new Error(`Evidence hash mismatch: ${entry.candidate.id}`);
      }
      const readPage = async (url: string) => {
        const proof = entry.evidence.find(p => p.url === url);
        if (!proof) return '';
        if (!successFactorsEmployerPageMatches(url, proof.respondedUrl)) throw new Error('Cross-origin evidence');
        return readFileSync(proof.file, 'utf8');
      };
      const url = entry.candidate.url!;
      const metadata = entry.employerWitness ? await verifiedMetadata(entry)
        : await recoverSuccessFactorsMetadata(await readPage(url), url, readPage);
      if (!metadata || normalizedSuccessFactorsTitle(metadata.title) !== normalizedSuccessFactorsTitle(entry.candidate.title)
        || (entry.company && entry.company !== metadata.company)
        || (entry.location && entry.location !== metadata.location)) throw new Error(`Evidence replay mismatch: ${entry.candidate.id}`);
    }
    for (const entry of plan.entries.filter(e => e.company || e.location)) {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Job" WHERE id=${entry.candidate.id} FOR UPDATE`;
        const current = await tx.job.findUnique({ where: { id: entry.candidate.id } });
        if (!current) return 'missing';
        if (current.title !== entry.candidate.title || current.url !== entry.candidate.url
          || current.sourceId !== entry.candidate.sourceId) return 'changed_since_preview';
        if (current.scoringStatus === 'scoring' || await tx.scoringBatchItem.count({ where: { jobId: current.id, status: 'leased' } })) return 'active_score_lease';
        const data: { company?: string; employer?: string; location?: string } = {};
        if (entry.company && missing(current.company)) {
          data.company = entry.company;
          if (missing(current.employer)) data.employer = entry.company;
        }
        if (entry.location && missing(current.location)) data.location = entry.location;
        if (!Object.keys(data).length) return 'already_complete';
        const after = await tx.job.update({ where: { id: current.id }, data });
        // Assert every other Job column (including scores, lifecycle, identity,
        // descriptions and artifact links) survived this exact transaction.
        for (const key of Object.keys(current) as Array<keyof typeof current>) {
          if (key === 'updatedAt' || key in data) continue;
          if (JSON.stringify(current[key]) !== JSON.stringify(after[key])) throw new Error(`Protected field changed: ${key}`);
        }
        await tx.jobPipelineEvent.create({ data: { eventKey: `successfactors-metadata-repair-v1:${current.id}:${hash(JSON.stringify(data))}`,
          jobId: current.id, eventType: 'source_metadata_repaired', stage: 'metadata', source: current.source, sourceId: current.sourceId,
          details: { repair: 'successfactors-metadata-v1', before: { company: current.company, employer: current.employer, location: current.location },
            after: data, evidence: entry.evidence.map(({ url, respondedUrl, sha256 }) => ({ url, respondedUrl, sha256 })) } } });
        return 'repaired';
      });
      receipts.push({ id: entry.candidate.id, result, company: entry.company, location: entry.location });
    }
    writeFileSync(planPath + '.receipt.json', JSON.stringify(receipts, null, 2));
    console.log(JSON.stringify({ candidates: plan.entries.length, results: receipts.reduce((counts, r) => {
      counts[r.result] = (counts[r.result] || 0) + 1; return counts;
    }, {} as Record<string, number>) }));
  } finally { await prisma.$disconnect(); }
}

(args.includes('--apply') ? apply() : args.includes('--link-employers') ? linkEmployers()
  : args.includes('--replay') ? replay() : collect()).catch(error => { console.error(error); process.exitCode = 1; });
