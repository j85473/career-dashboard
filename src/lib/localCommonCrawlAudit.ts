import type { AtsDiscoveryLocalScan, Prisma, PrismaClient } from './prismaClient';
import { PLATFORMS } from '../scripts/discoverATS';
import { isFirstCollectionPlatform } from './atsFirstCollectionAdmission';
import {
  downloadLocalCrawlDirectory, localCrawlBlockFile, localCrawlDirectoryFile, localCrawlPatternMatches,
  localCrawlPlanHash, planLocalCrawl, readLocalCrawlBlock, removeLocalCrawlFile, requireLocalCrawlSpace,
  type LocalCrawlConfig, type LocalCrawlPattern, type LocalCrawlPlan,
} from './localCommonCrawl';

type PatternStats = { blocksRead: number; recordsRead: number; candidatesQueued: number };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const whereScan = (scan: Pick<AtsDiscoveryLocalScan, 'runId' | 'indexId' | 'planHash'>) => ({
  runId_indexId_planHash: { runId: scan.runId, indexId: scan.indexId, planHash: scan.planHash },
});

export function savedLocalCrawlPlan(scan: AtsDiscoveryLocalScan): LocalCrawlPlan {
  const plan = scan.plan as unknown as LocalCrawlPlan;
  if (plan.version !== 1 || plan.indexId !== scan.indexId || !Array.isArray(plan.blocks) || !Array.isArray(plan.patterns)
    || localCrawlPlanHash(plan) !== scan.planHash || !Number.isInteger(scan.nextBlock)
    || scan.nextBlock < 0 || scan.nextBlock > plan.blocks.length) throw new Error('Saved local crawl plan or cursor failed verification.');
  if (plan.patterns.some(p => !Object.hasOwn(PLATFORMS, p.platform))) throw new Error('A saved local crawl still needs a missing ATS adapter.');
  return plan;
}

function savedStats(scan: AtsDiscoveryLocalScan, plan: LocalCrawlPlan): PatternStats[] {
  const stats = scan.stats as unknown as PatternStats[];
  if (!Array.isArray(stats) || stats.length !== plan.patterns.length || stats.some(row =>
    !row || [row.blocksRead, row.recordsRead, row.candidatesQueued].some(n => !Number.isSafeInteger(n) || n < 0))) {
    throw new Error('Saved local crawl statistics failed verification.');
  }
  for (let i = 0; i < stats.length; i++) {
    const expected = plan.blocks.slice(0, scan.nextBlock).filter(block => block.patterns.includes(i)).length;
    if (stats[i].blocksRead !== expected) throw new Error('Saved local crawl statistics do not match its committed blocks.');
  }
  return stats.map(row => ({ ...row }));
}

/** The next block cannot commit unless its candidates and counts commit too. */
export async function saveLocalCrawlBlock(client: PrismaClient, scan: AtsDiscoveryLocalScan,
  records: Array<{ url: string }>): Promise<AtsDiscoveryLocalScan> {
  const plan = savedLocalCrawlPlan(scan);
  const block = plan.blocks[scan.nextBlock];
  if (!block || scan.status !== 'running') throw new Error('Local crawl is not ready for another block.');
  const stats = savedStats(scan, plan);
  return client.$transaction(async tx => {
    const claimed = await tx.atsDiscoveryLocalScan.updateMany({
      where: { runId: scan.runId, indexId: scan.indexId, planHash: scan.planHash, nextBlock: scan.nextBlock, status: 'running' },
      data: { nextBlock: scan.nextBlock + 1 },
    });
    if (claimed.count !== 1) throw new Error('Another worker advanced this local crawl; reload its saved cursor.');
    let queued = 0; let matched = 0;
    for (const patternIndex of block.patterns) {
      const { platform, pattern } = plan.patterns[patternIndex];
      const extractor = PLATFORMS[platform as keyof typeof PLATFORMS].extract_slug;
      const exact = new Map<string, { slug: string; normalizedSlug: string; sourceUrl: string; sourceIndexId: string }>();
      const matching = records.filter(record => localCrawlPatternMatches(pattern, record.url));
      for (const { url } of matching) {
        const slug = extractor(url)?.trim();
        if (slug && !exact.has(slug)) exact.set(slug, { slug, normalizedSlug: slug.toLocaleLowerCase('en-US'), sourceUrl: url, sourceIndexId: scan.indexId });
      }
      const candidates = [...exact.values()];
      let inserted = 0;
      for (let offset = 0; offset < candidates.length; offset += 1000) {
        const chunk = candidates.slice(offset, offset + 1000);
        const result = await tx.atsDiscoveryAuditCandidate.createMany({
          data: chunk.map(candidate => ({ runId: scan.runId, platform, ...candidate })), skipDuplicates: true,
        });
        inserted += result.count;
        if (isFirstCollectionPlatform(platform)) await tx.atsFirstCollectionCandidate.createMany({
          data: chunk.map(candidate => ({ platform, slug: candidate.slug, sourceUrl: candidate.sourceUrl, discoveryRunId: scan.runId })), skipDuplicates: true,
        });
      }
      stats[patternIndex].blocksRead++;
      stats[patternIndex].recordsRead += matching.length;
      stats[patternIndex].candidatesQueued += inserted;
      queued += inserted; matched += matching.length;
    }
    await tx.atsDiscoveryAuditRun.update({ where: { id: scan.runId }, data: {
      pagesRead: { increment: 1 }, recordsRead: { increment: matched }, candidatesQueued: { increment: queued }, lastError: null,
    } });
    return tx.atsDiscoveryLocalScan.update({ where: whereScan(scan), data: { stats: json(stats) } });
  }, { timeout: 30_000 });
}

export async function finishLocalCrawlScan(client: PrismaClient, scan: AtsDiscoveryLocalScan): Promise<AtsDiscoveryLocalScan> {
  const plan = savedLocalCrawlPlan(scan); const stats = savedStats(scan, plan);
  if (scan.nextBlock !== plan.blocks.length) throw new Error('Cannot complete a local crawl with unread blocks.');
  return client.$transaction(async tx => {
    // Optimistic guard makes completion idempotent without replacing receipts.
    const current = await tx.atsDiscoveryLocalScan.findUniqueOrThrow({ where: whereScan(scan) });
    if (current.nextBlock !== plan.blocks.length || localCrawlPlanHash(savedLocalCrawlPlan(current)) !== scan.planHash) {
      throw new Error('Local crawl completion cursor changed.');
    }
    for (const [i, pattern] of plan.patterns.entries()) {
      await tx.atsDiscoveryAuditIndexReceipt.upsert({
        where: { runId_platform_pattern_indexId: { runId: scan.runId, ...pattern, indexId: scan.indexId } }, update: {},
        create: { runId: scan.runId, ...pattern, indexId: scan.indexId,
          pagesRead: stats[i].blocksRead, recordsRead: stats[i].recordsRead, candidatesQueued: stats[i].candidatesQueued },
      });
    }
    return tx.atsDiscoveryLocalScan.update({ where: whereScan(scan), data: { status: 'complete', completedAt: current.completedAt || new Date() } });
  }, { timeout: 30_000 });
}

async function cleanupCommittedBlocks(config: LocalCrawlConfig, scan: AtsDiscoveryLocalScan): Promise<void> {
  for (let i = 0; i < scan.nextBlock; i++) {
    const filename = localCrawlBlockFile(config.workspace, scan.planHash, i);
    await removeLocalCrawlFile(filename);
    await removeLocalCrawlFile(`${filename}.part`);
  }
  if (scan.status === 'complete') {
    await removeLocalCrawlFile(localCrawlDirectoryFile(config.workspace, scan.indexId));
    await removeLocalCrawlFile(`${localCrawlDirectoryFile(config.workspace, scan.indexId)}.part`);
  }
}

export type LocalCrawlScanDependencies = {
  readBlock: typeof readLocalCrawlBlock;
  saveBlock: typeof saveLocalCrawlBlock;
  finish: typeof finishLocalCrawlScan;
  remove: typeof removeLocalCrawlFile;
  space: typeof requireLocalCrawlSpace;
  wait: (ms: number) => Promise<void>;
};

/** A failed save leaves the downloaded block intact and its cursor unchanged. */
export async function consumeLocalCrawlScan(client: PrismaClient, initial: AtsDiscoveryLocalScan, config: LocalCrawlConfig,
  afterBlock: () => Promise<unknown> = async () => {}, dependencies: LocalCrawlScanDependencies = {
    readBlock: readLocalCrawlBlock, saveBlock: saveLocalCrawlBlock, finish: finishLocalCrawlScan,
    remove: removeLocalCrawlFile, space: requireLocalCrawlSpace,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }): Promise<AtsDiscoveryLocalScan> {
  let scan = initial; const plan = savedLocalCrawlPlan(scan);
  for (; scan.nextBlock < plan.blocks.length;) {
    const ordinal = scan.nextBlock; const block = plan.blocks[ordinal];
    await dependencies.space(config, block.length);
    const records = await dependencies.readBlock(plan, ordinal, config.workspace);
    scan = await dependencies.saveBlock(client, scan, records);
    // No deletion is reachable until the database transaction has returned.
    await dependencies.remove(localCrawlBlockFile(config.workspace, scan.planHash, ordinal));
    console.log(`[Local CC] ${scan.indexId}: saved block ${scan.nextBlock}/${plan.blocks.length}; ${records.length} records checked.`);
    await afterBlock();
    await dependencies.wait(config.delayMs);
  }
  return dependencies.finish(client, scan);
}

/** Finish one immutable plan before considering newly added URL patterns. */
export async function scanLocalCrawl(client: PrismaClient, runId: string, indexId: string,
  patterns: LocalCrawlPattern[], config: LocalCrawlConfig, afterBlock: () => Promise<unknown>): Promise<void> {
  for (;;) {
    const completed = await client.atsDiscoveryLocalScan.findMany({ where: { runId, indexId, status: 'complete' } });
    for (const saved of completed) await cleanupCommittedBlocks(config, saved);
    let scan = await client.atsDiscoveryLocalScan.findFirst({ where: { runId, indexId, status: 'running' }, orderBy: { createdAt: 'asc' } });
    if (!scan) {
      const receipts = await client.atsDiscoveryAuditIndexReceipt.findMany({ where: { runId, indexId }, select: { platform: true, pattern: true } });
      const covered = new Set(receipts.map(p => JSON.stringify([p.platform, p.pattern])));
      const missing = patterns.filter(p => !covered.has(JSON.stringify([p.platform, p.pattern])));
      if (!missing.length) return;
      await requireLocalCrawlSpace(config, 512 * 1024 ** 2);
      const filename = await downloadLocalCrawlDirectory(config.workspace, indexId);
      const plan = await planLocalCrawl(filename, indexId, missing);
      const planHash = localCrawlPlanHash(plan);
      scan = await client.atsDiscoveryLocalScan.create({ data: {
        runId, indexId, planHash, plan: json(plan), stats: json(missing.map(() => ({ blocksRead: 0, recordsRead: 0, candidatesQueued: 0 }))),
      } });
      console.log(`[Local CC] ${indexId}: ${plan.blocks.length} compressed blocks, ${plan.compressedBytes} bytes, ${missing.length} URL patterns; plan saved.`);
      await new Promise(resolve => setTimeout(resolve, config.delayMs));
    }
    await cleanupCommittedBlocks(config, scan);
    const finished = await consumeLocalCrawlScan(client, scan, config, afterBlock);
    await cleanupCommittedBlocks(config, finished);
    console.log(`[Local CC] ${indexId}: receipts saved; temporary directory and compressed blocks removed.`);
  }
}
