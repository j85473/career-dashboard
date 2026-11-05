import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { readPublishedAtsBoardEmployer, readPublishedAtsPostingEvidence } from '../src/lib/atsEmployerRecovery';
import { fetchAtsPlatformResponse } from '../src/lib/atsProviderRequest';
import { reserveProviderBudgetForSource } from '../src/lib/ingestionControl';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { readBoundedAtsBody } from '../src/lib/tenantAtsBoards';
import { publicAtsBoardSlugFromUrl, publicAtsBoardUrl } from '../src/lib/publicAtsBoards';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { applyRetainedEmployerPlan, retainedEmployerPlanHash, type RetainedEmployerPlan } from '../src/lib/retainedAtsEmployerRepair';

async function main() {
  const [mode, filename, selectionHash, ...extra] = process.argv.slice(2);
  if (!['--collect', '--collect-postings', '--apply'].includes(mode) || !filename || extra.length
    || (mode !== '--apply' && selectionHash) || (mode === '--apply' && !selectionHash)) {
    throw new Error('Use --collect or --collect-postings <plan.json>, or --apply <plan.json> <selectionHash>. Collection resumes the saved plan.');
  }
  await fs.mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  const lock = await fs.open(`${filename}.lock`, 'wx');
  try {
    let plan: RetainedEmployerPlan;
    try { plan = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mode === '--apply') throw error;
      const segments = await prisma.atsIngestionSegment.findMany({
        where: { status: { in: ['published', 'processing'] },
          holdReason: { in: ['oracle downloaded work awaits a verified employer', 'ukg downloaded work awaits a verified employer'] },
          batch: { writerMode: 'v2', platform: { in: ['oracle', 'ukg'] } } },
        select: { id: true, processingOffset: true, itemCount: true, manifestHash: true, batchId: true, ledgerGeneration: true, firstOrdinal: true,
          batch: { select: { platform: true, slug: true } } }, orderBy: { id: 'asc' },
      });
      const boards = new Map<string, RetainedEmployerPlan['boards'][number]>();
      for (const { batch, batchId, ledgerGeneration, firstOrdinal, ...segment } of segments) {
        const key = mode === '--collect-postings' ? segment.id : `${batch.platform}:${batch.slug}`;
        let job: Record<string, unknown> | undefined;
        if (mode === '--collect-postings') {
          const item = await prisma.atsIngestionItem.findUniqueOrThrow({ where: { batchId_ledgerGeneration_canonicalOrdinal: {
            batchId, ledgerGeneration, canonicalOrdinal: firstOrdinal + segment.processingOffset,
          } }, select: { rawJson: true, enrichmentOverlay: true } });
          job = { ...item.rawJson as Record<string, unknown>, ...item.enrichmentOverlay as Record<string, unknown> };
        }
        if (!boards.has(key)) boards.set(key, { ...batch, ...(job ? { job } : {}), company: '', checkedAt: null, error: null, sources: [], segments: [] });
        boards.get(key)!.segments.push(segment);
      }
      plan = { version: 1, createdAt: new Date().toISOString(), complete: false, boards: [...boards.values()] };
    }
    if (mode === '--apply') {
      console.log(JSON.stringify(await applyRetainedEmployerPlan(prisma, plan, selectionHash), null, 2));
      return;
    }
    if (plan.version !== 1) throw new Error('Unsupported recovery plan.');
    let checkpoint = Promise.resolve();
    const save = () => {
      checkpoint = checkpoint.then(async () => {
        await fs.writeFile(`${filename}.tmp`, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
        await fs.rename(`${filename}.tmp`, filename);
      });
      return checkpoint;
    };
    const collect = async (board: RetainedEmployerPlan['boards'][number]) => {
      if (board.checkedAt) return;
      const signal = AbortSignal.timeout(15000);
      try {
        const dependencies = {
          registry: async () => '',
          useWebsiteCache: false,
          fetchPage: async (url: string) => {
            const host = new URL(publicAtsBoardUrl(board.platform as 'oracle' | 'ukg', board.slug)).hostname;
            const request = () => safeExternalFetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const providerRequest = new URL(url).hostname === host || publicAtsBoardSlugFromUrl(url, 'ukg') !== null;
            const response = providerRequest ? await fetchAtsPlatformResponse(board.platform, signal, async () => {
              const budget = await reserveProviderBudgetForSource(`ATS-${board.platform}`);
              if (!budget.allowed) throw new Error('Provider cooldown; evidence remains unresolved.');
              if (board.job) {
                const details = await reserveProviderBudgetForSource(`ATS-${board.platform} Details`);
                if (!details.allowed) throw new Error('Detail request budget; evidence remains unresolved.');
              }
              return request();
            }, { requestedUrl: url, boardSlug: board.slug, recordPlatformFailures: false }) : await request();
            const body = await readBoundedAtsBody(response, 3_000_000);
            board.sources.push({ requestedUrl: url, responseUrl: response.url || url, status: response.status,
              body, hash: canonicalJsonSha256(body) });
            const recorded = new Response(response.status === 204 ? null : body, { status: response.status });
            Object.defineProperty(recorded, 'url', { value: response.url || url });
            return recorded;
          },
        };
        if (board.job) {
          board.evidence = await readPublishedAtsPostingEvidence(board.platform, board.slug, board.job, dependencies);
          board.company = board.evidence?.company || '';
        } else board.company = await readPublishedAtsBoardEmployer(board.platform, board.slug, dependencies);
        if (!board.company) board.error = 'Published source evidence did not establish an employer.';
      } catch (error) { board.error = error instanceof Error ? error.message : String(error); }
      board.checkedAt = new Date().toISOString();
      await save();
      console.log(JSON.stringify({ checked: plan.boards.filter(board => board.checkedAt).length, total: plan.boards.length,
        platform: board.platform, slug: board.slug, company: board.company, error: board.error }));
    };
    let index = 0;
    const results = await Promise.allSettled(Array.from({ length: 2 }, async () => {
      while (index < plan.boards.length) await collect(plan.boards[index++]);
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    plan.complete = true;
    await fs.writeFile(`${filename}.tmp`, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    await fs.rename(`${filename}.tmp`, filename);
    console.log(JSON.stringify({ selectionHash: retainedEmployerPlanHash(plan), boards: plan.boards.length,
      verifiedBoards: plan.boards.filter(board => board.company).length,
      verifiedHeldItems: plan.boards.filter(board => board.company).flatMap(board => board.segments)
        .reduce((n, segment) => n + segment.itemCount - segment.processingOffset, 0),
      jobWrites: 0, scoreWrites: 0 }));
  } finally { await lock.close(); await fs.unlink(`${filename}.lock`); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
