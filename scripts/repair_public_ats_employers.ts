import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { corroboratedOracleEmployer } from '../src/lib/oracleEmployerEvidence';
import { oraclePostingDetailUrl, parseOraclePostingDetail } from '../src/lib/oraclePosting';
import { parseUkgPostingHtml } from '../src/lib/ukgPosting';
import { resolveUkgBoardEmployer, oracleBrandedEmployer, ukgBoardBranding, employerWebsiteName, oracleCareerSiteUrl, oracleCareerSiteEmployer } from '../src/lib/publicAtsEmployer';
import { publicAtsBoardSlugFromUrl, publicAtsBoardUrl } from '../src/lib/publicAtsBoards';
import { generateV4Fingerprint } from '../src/lib/jobIngestion';
import { VERIFIED_ATS_EMPLOYER_RULE, VERIFIED_ATS_EMPLOYER_ORIGIN } from '../src/lib/atsEmployerRegistry';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';

/** Source-backed name corrections only. Never alters scores, status, JD or posting identity. */
type Candidate = { id: string; title: string; company: string; employer: string | null; url: string | null; source: string | null; sourceId: string | null };
type Evidence = { url: string; respondedUrl?: string; sha256: string; file: string };
type Entry = { candidate: Candidate; company: string; evidence: Evidence[]; error?: string; oracleEmployerWitness?: { url: string } };
type Plan = { version: 1; capturedAt: string; entries: Entry[] };
const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const planPath = resolve(option('--plan') || 'data/runtime/public-ats-employer-repair.json');
const apply = args.includes('--apply');
const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const save = (plan: Plan) => { mkdirSync(dirname(planPath), { recursive: true }); writeFileSync(`${planPath}.tmp`, JSON.stringify(plan, null, 2)); renameSync(`${planPath}.tmp`, planPath); };

async function collect(): Promise<Plan> {
  const candidateFile = option('--candidates');
  const rows: Candidate[] = candidateFile ? JSON.parse(readFileSync(candidateFile, 'utf8')).unknown
    : await prisma.job.findMany({ where: { source: { in: ['ATS-oracle', 'ATS-ukg'] }, company: { equals: 'Unknown Company', mode: 'insensitive' } },
      select: { id: true, title: true, company: true, employer: true, url: true, source: true, sourceId: true }, orderBy: { id: 'asc' } });
  const plan: Plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : { version: 1, capturedAt: new Date().toISOString(), entries: [] };
  if (args.includes('--retry-unresolved')) plan.entries = plan.entries.filter(entry => entry.company);
  const completed = new Set(plan.entries.map(entry => entry.candidate.id));
  const candidates = rows.filter(row => ['ATS-oracle', 'ATS-ukg'].includes(row.source || '') && !completed.has(row.id));
  mkdirSync(`${planPath}.evidence`, { recursive: true });
  const cached = new Map<string, Promise<{ body: string; response: Response; file: string }>>();
  const get = async (url: string) => {
    let result = cached.get(url);
    if (!result) {
      result = (async () => {
        const response = await safeExternalFetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        const file = `${planPath}.evidence/${sha(url)}-${sha(body)}.txt`; writeFileSync(file, body);
        return { body, response, file };
      })();
      cached.set(url, result);
    }
    return result;
  };
  // Bounded public reads; no retries against a rate limit in this pass.
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const results = await Promise.all(candidates.slice(offset, offset + 4).map(async candidate => {
      const evidence: Evidence[] = [];
      const page = async (url: string) => {
        const result = await get(url); evidence.push({ url, respondedUrl: result.response.url || url, sha256: sha(result.body), file: result.file });
        return result;
      };
      try {
        if (!candidate.url) throw new Error('missing posting URL');
        let company = '';
        if (candidate.source === 'ATS-oracle') {
          const detail = oraclePostingDetailUrl(candidate.url);
          if (!detail) throw new Error('invalid Oracle posting identity');
          const result = await page(detail.href);
          company = parseOraclePostingDetail(JSON.parse(result.body), candidate.url)?.company || '';
          if (!company) {
            const html = await page(candidate.url);
            company = oracleBrandedEmployer(html.body, candidate.url);
          }
          if (!company) {
            const site = await page(oracleCareerSiteUrl(candidate.url));
            company = oracleCareerSiteEmployer(JSON.parse(site.body), candidate.url);
          }
        } else {
          const html = await page(candidate.url);
          const posting = parseUkgPostingHtml(html.body, candidate.url);
          company = posting?.company || await resolveUkgBoardEmployer(html.body, candidate.url, async url => {
            const result = await page(url);
            const replay = new Response(result.body, { status: result.response.status });
            Object.defineProperty(replay, 'url', { value: result.response.url || url });
            return replay;
          });
        }
        return { candidate, company, evidence, ...(!company ? { error: 'employer not verified' } : {}) };
      } catch (error) { return { candidate, company: '', evidence, error: error instanceof Error ? error.message : String(error) }; }
    }));
    plan.entries.push(...results); save(plan);
    console.log(JSON.stringify({ inspected: plan.entries.length, total: rows.length, verified: plan.entries.filter(entry => entry.company).length }));
    if (results.some(entry => entry.error === 'HTTP 429')) throw new Error('Source rate limit; checkpoint retained. Resume later.');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  return plan;
}

function evidenceEmployer(entry: Entry): string {
  const url = entry.candidate.url;
  if (!url) return '';
  const bodyAt = (target: string) => {
    const proof = entry.evidence.find(item => item.url === target);
    return proof ? readFileSync(proof.file, 'utf8') : '';
  };
  if (entry.candidate.source === 'ATS-oracle') {
    const detail = oraclePostingDetailUrl(url);
    if (!detail) return '';
    try {
      const payload = JSON.parse(bodyAt(detail.href));
      const slug = publicAtsBoardSlugFromUrl(url, 'oracle');
      const pageHtml = bodyAt(url) || (slug ? bodyAt(publicAtsBoardUrl('oracle', slug)) : '');
      const direct = parseOraclePostingDetail(payload, url, pageHtml)?.company || '';
      const ownClosedPosting = new URL(url).hostname === 'eeho.fa.us2.oraclecloud.com'
        ? oracleBrandedEmployer(bodyAt(url), url) || (slug ? oracleBrandedEmployer(bodyAt(publicAtsBoardUrl('oracle', slug)), url) : '') : '';
      const siteBody = bodyAt(oracleCareerSiteUrl(url));
      const siteCompany = siteBody ? oracleCareerSiteEmployer(JSON.parse(siteBody), url) : '';
      const witnessUrl = entry.oracleEmployerWitness?.url;
      const witnessDetail = witnessUrl ? oraclePostingDetailUrl(witnessUrl) : null;
      return direct || ownClosedPosting || siteCompany || (witnessUrl && witnessDetail ? corroboratedOracleEmployer(payload, url,
        { payload: JSON.parse(bodyAt(witnessDetail.href)), url: witnessUrl, pageHtml: bodyAt(witnessUrl) }) : '');
    }
    catch { return ''; }
  }
  if (entry.candidate.source === 'ATS-ukg') {
    const html = bodyAt(url), posting = parseUkgPostingHtml(html, url);
    if (posting?.company) return posting.company;
    const branding = ukgBoardBranding(html, url);
    if (branding.company) return branding.company;
    const website = entry.evidence.find(proof => proof.url === branding.employerUrl && proof.respondedUrl);
    return website ? employerWebsiteName(readFileSync(website.file, 'utf8'), website.url, website.respondedUrl) : '';
  }
  return '';
}

function linkOracleEvidence(plan: Plan): void {
  const witnesses = plan.entries.filter(entry => entry.candidate.source === 'ATS-oracle' && entry.company
    && entry.evidence.every(proof => sha(readFileSync(proof.file, 'utf8')) === proof.sha256)
    && evidenceEmployer(entry) === entry.company && !entry.oracleEmployerWitness);
  for (const entry of plan.entries.filter(entry => entry.candidate.source === 'ATS-oracle' && !entry.company)) {
    const url = entry.candidate.url;
    if (!url) continue;
    const detail = oraclePostingDetailUrl(url);
    const proof = entry.evidence.find(item => item.url === detail?.href);
    if (!proof || sha(readFileSync(proof.file, 'utf8')) !== proof.sha256) continue;
    try {
      const payload = JSON.parse(readFileSync(proof.file, 'utf8'));
      for (const witness of witnesses) {
        const otherUrl = witness.candidate.url;
        const otherDetail = otherUrl ? oraclePostingDetailUrl(otherUrl) : null;
        const otherProof = witness.evidence.find(item => item.url === otherDetail?.href);
        if (!otherUrl || !otherProof) continue;
        const page = witness.evidence.find(item => item.url === otherUrl);
        const company = corroboratedOracleEmployer(payload, url, { payload: JSON.parse(readFileSync(otherProof.file, 'utf8')),
          url: otherUrl, pageHtml: page ? readFileSync(page.file, 'utf8') : '' });
        if (!company) continue;
        entry.company = company; entry.oracleEmployerWitness = { url: otherUrl }; delete entry.error;
        const urls = new Set(entry.evidence.map(item => item.url));
        entry.evidence.push(...witness.evidence.filter(item => !urls.has(item.url)));
        break;
      }
    } catch { /* Unparseable/absent source records remain unresolved. */ }
  }
}

async function main() {
  const plan: Plan = apply || args.includes('--link-evidence') ? JSON.parse(readFileSync(planPath, 'utf8')) : await collect();
  if (plan.version !== 1) throw new Error('Unsupported repair plan');
  if (!apply) { linkOracleEvidence(plan); save(plan); }
  const receipt: Array<{ id: string; company: string; result: string }> = [];
  if (apply) {
    for (const entry of plan.entries.filter(entry => entry.company)) {
      if (!entry.evidence.length || entry.evidence.some(proof => sha(readFileSync(proof.file, 'utf8')) !== proof.sha256)
        || evidenceEmployer(entry) !== entry.company) throw new Error(`Employer evidence verification failed for ${entry.candidate.id}`);
    }
    // A board cache is safe only when all recovered names agree. A board with
    // multiple legal employers (such as Intercorp) never receives one name.
    const boards = new Map<string, Entry[]>();
    for (const entry of plan.entries.filter(entry => entry.company)) {
      const source = entry.candidate.source?.slice(4);
      const slug = entry.candidate.sourceId?.split('::').slice(0, -1).join('::');
      if (source && slug) { const key = `${source}:${slug}`; boards.set(key, [...(boards.get(key) || []), entry]); }
    }
    for (const [key, entries] of boards) {
      const names = [...new Set(entries.map(entry => entry.company))];
      if (names.length !== 1 || !entries.every(entry => entry.evidence.length
        && entry.evidence.every(proof => sha(readFileSync(proof.file, 'utf8')) === proof.sha256))) continue;
      // Do not turn a posting-level legal employer into a board-wide rule.
      if (key.startsWith('oracle:') && !key.startsWith('oracle:eeho.fa.us2.oraclecloud.com::')) continue;
      const current = await prisma.companyNameRule.findUnique({ where: { matchType_matchKey: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey: key } } });
      if (current && current.origin !== VERIFIED_ATS_EMPLOYER_ORIGIN) continue;
      await prisma.companyNameRule.upsert({ where: { matchType_matchKey: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey: key } },
        create: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey: key, standardName: names[0], origin: VERIFIED_ATS_EMPLOYER_ORIGIN,
          evidence: { repair: 'public-ats-employer-v1', sources: entries[0].evidence }, provenanceJobId: entries[0].candidate.id },
        update: { standardName: names[0], evidence: { repair: 'public-ats-employer-v1', sources: entries[0].evidence } } });
    }
    for (const entry of plan.entries.filter(entry => entry.company)) {
      if (!entry.evidence.length || entry.evidence.some(proof => sha(readFileSync(proof.file, 'utf8')) !== proof.sha256)) throw new Error('Repair evidence hash mismatch');
      const result = await prisma.$transaction(async tx => {
        const job = await tx.job.findUnique({ where: { id: entry.candidate.id }, include: { scoringBatchItems: { where: { status: 'leased' }, take: 1, select: { id: true } } } });
        if (!job) return 'missing';
        if (job.company === entry.company && job.employer === entry.company) return 'already repaired';
        if (job.company !== entry.candidate.company || job.employer !== entry.candidate.employer || job.title !== entry.candidate.title
          || job.url !== entry.candidate.url || job.sourceId !== entry.candidate.sourceId || job.source !== entry.candidate.source) return 'changed since inspection';
        if (job.scoringStatus === 'scoring' || job.batchJobId || job.afBatchId || job.jdBatchId || job.tailoringStaged || job.scoringBatchItems.length) return 'active work protected';
        const updated = await tx.job.updateMany({ where: { id: job.id, updatedAt: job.updatedAt, company: job.company, employer: job.employer,
          scoringStatus: { not: 'scoring' }, batchJobId: null, afBatchId: null, jdBatchId: null, tailoringStaged: false,
          scoringBatchItems: { none: { status: 'leased' } } }, data: { company: entry.company, employer: entry.company,
          identityFingerprint: generateV4Fingerprint(job.title, entry.company, job.location || 'Unknown Location') } });
        if (!updated.count) return 'concurrent change protected';
        await recordJobPipelineEvent({ eventType: 'metadata_repaired', jobId: job.id, source: job.source, sourceId: job.sourceId,
          stage: 'employer_identity', identityParts: ['public-ats-employer-v1', entry.company],
          details: { repair: 'public-ats-employer-v1', previousCompany: job.company, previousEmployer: job.employer,
            company: entry.company, evidence: entry.evidence, scoresPreserved: true } }, tx);
        return 'repaired';
      }, { isolationLevel: 'Serializable' });
      receipt.push({ id: entry.candidate.id, company: entry.company, result });
    }
    writeFileSync(`${planPath}.receipt.json`, JSON.stringify(receipt, null, 2));
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', inspected: plan.entries.length, verified: plan.entries.filter(entry => entry.company).length,
    unresolved: plan.entries.filter(entry => !entry.company).length, results: receipt.reduce<Record<string, number>>((counts, row) => { counts[row.result] = (counts[row.result] || 0) + 1; return counts; }, {}) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
