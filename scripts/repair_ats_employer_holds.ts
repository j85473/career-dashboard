import { prisma } from '../src/lib/prisma';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { readPublishedAtsBoardEmployer } from '../src/lib/atsEmployerRecovery';
import { fetchAtsPlatformResponse } from '../src/lib/jobIngestion';
import { reserveProviderBudgetForSource } from '../src/lib/ingestionControl';
import { VERIFIED_ATS_EMPLOYER_RULE, VERIFIED_ATS_EMPLOYER_ORIGIN } from '../src/lib/atsEmployerRegistry';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { publicAtsBoardUrl } from '../src/lib/publicAtsBoards';

// Exact held sites found by the October 12 audit. No global employer aliases,
// existing Job edits, or broad retry/reset operation are permitted here.
const boards = [
  { platform: 'oracle', slug: 'edel.fa.us2.oraclecloud.com::CX_2001' },
  { platform: 'oracle', slug: 'eeho.fa.us2.oraclecloud.com::CX' },
  { platform: 'zohorecruit', slug: 'venuebrandexperience.zohorecruit.com::Careers' },
];

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const expected = args.find(arg => arg.startsWith('--selection-hash='))?.slice('--selection-hash='.length);
  if (args.some(arg => arg !== '--apply' && !arg.startsWith('--selection-hash=')) || (apply && !expected)) {
    throw new Error('Use --apply --selection-hash=<reviewed dry-run hash>, or no arguments for a dry run.');
  }
  const plan: Array<{ platform: string; slug: string; company: string;
    sources: Array<{ url: string; hash: string }>;
    segments: Array<{ id: string; processingOffset: number; itemCount: number; nextProcessAt: Date | null }> }> = [];
  for (const board of boards) {
    const sources: Array<{ url: string; hash: string }> = [];
    const company = await readPublishedAtsBoardEmployer(board.platform, board.slug, {
      registry: async () => '', // Fresh public verification even if a rule exists.
      fetchPage: async url => {
        const signal = AbortSignal.timeout(15000);
        const boardHost = new URL(publicAtsBoardUrl(board.platform as 'oracle' | 'zohorecruit', board.slug)).hostname;
        const fetchPage = () => safeExternalFetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const response = new URL(url).hostname !== boardHost ? await fetchPage() : await fetchAtsPlatformResponse(board.platform, signal, async () => {
          const allowed = await reserveProviderBudgetForSource('ATS-' + board.platform);
          if (!allowed.allowed) throw new Error('Public verification awaits the provider cooldown');
          return fetchPage();
        }, { requestedUrl: url, boardSlug: board.slug, recordPlatformFailures: false });
        sources.push({ url: response.url || url, hash: canonicalJsonSha256(await response.clone().text()) });
        return response;
      },
    });
    if (!company) throw new Error('No verified employer for ' + board.platform + ':' + board.slug);
    const segments = await prisma.atsIngestionSegment.findMany({
      where: { status: 'published', leaseToken: null, batch: { platform: board.platform, slug: board.slug } },
      select: { id: true, processingOffset: true, itemCount: true, nextProcessAt: true }, orderBy: { id: 'asc' },
    });
    plan.push({ ...board, company, segments, sources });
  }
  // Source response bytes can vary between reads. The approved scope binds the
  // verified name, board and exact segment counters; both reads retain proofs.
  const selectionHash = canonicalJsonSha256(plan.map(({ platform, slug, company, segments }) => ({ platform, slug, company,
    segments: segments.map(segment => ({ ...segment, nextProcessAt: segment.nextProcessAt?.toISOString() || null })),
  })));
  if (apply && expected !== selectionHash) throw new Error('Recovery scope changed; repeat the dry run.');
  let released = 0;
  if (apply) await prisma.$transaction(async tx => {
    for (const item of plan) {
      const matchKey = item.platform + ':' + item.slug;
      const prior = await tx.companyNameRule.findUnique({ where: { matchType_matchKey: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey } } });
      if (prior && (prior.origin !== VERIFIED_ATS_EMPLOYER_ORIGIN || prior.standardName !== item.company)) {
        throw new Error('An existing employer rule conflicts with this source proof.');
      }
      await tx.companyNameRule.upsert({
        where: { matchType_matchKey: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey } },
        create: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey, standardName: item.company, origin: VERIFIED_ATS_EMPLOYER_ORIGIN,
          evidence: { sources: item.sources, verifiedAt: new Date().toISOString(), selectionHash } },
        update: { evidence: { sources: item.sources, verifiedAt: new Date().toISOString(), selectionHash } },
      });
      for (const segment of item.segments) {
        const result = await tx.atsIngestionSegment.updateMany({
          where: { id: segment.id, status: 'published', leaseToken: null, processingOffset: segment.processingOffset,
            itemCount: segment.itemCount, nextProcessAt: segment.nextProcessAt },
          data: { nextProcessAt: new Date() },
        });
        if (result.count !== 1) throw new Error('A held segment changed during recovery.');
        released += result.count;
      }
    }
  }, { isolationLevel: 'Serializable', timeout: 15000 });
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', selectionHash, released,
    boards: plan.map(item => ({ platform: item.platform, slug: item.slug, company: item.company,
      segments: item.segments.length, remainingItems: item.segments.reduce((sum, s) => sum + s.itemCount - s.processingOffset, 0), sources: item.sources })),
    jobWrites: 0, scoreWrites: 0 }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
