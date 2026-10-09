import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { scrapeAtsApi } from '../src/lib/atsApi';
import { repairPostingAtsLabel, repairPostingDescriptionFormatting } from '../src/lib/postingExtractionRepair';

/**
 * Dry run by default. --apply corrects only extraction-method ATS labels and
 * restores paragraph/list structure when the exact historical prose survives.
 * No scores, score events, statuses, source identity, facts, or queues change.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply')) throw new Error('Usage: repair_posting_extraction_metadata.ts [--apply]');
  const apply = args.includes('--apply');
  const candidates = await prisma.job.findMany({
    where: { OR: [
      { manualAts: { equals: 'JobPosting JSON-LD', mode: 'insensitive' } },
      { url: { contains: '.myworkdaysite.com/' }, NOT: { description: { contains: '\n' } } },
    ] },
    select: { id: true, url: true, canonicalUrl: true, source: true, manualAts: true,
      description: true, updatedAt: true, batchJobId: true, afBatchId: true, jdBatchId: true, scoringStatus: true },
    orderBy: { id: 'asc' },
  });
  let labels = 0;
  let descriptions = 0;
  let changed = 0;
  let conflicts = 0;
  let unrecovered = 0;
  for (const job of candidates) {
    const data: { manualAts?: string | null; description?: string } = repairPostingAtsLabel(job) || {};
    if (job.description && !job.description.includes('\n') && job.url) {
      try {
        // The visible employer URL can be more authoritative than a preserved
        // DEjobs canonical URL, so recover from the saved posting itself.
        const recovered = await scrapeAtsApi(job.url);
        const formatted = recovered?.text
          ? repairPostingDescriptionFormatting(job.description, recovered.text) : null;
        if (formatted) data.description = formatted;
        else unrecovered++;
      } catch { unrecovered++; }
    }
    if (!Object.keys(data).length) continue;
    if (job.batchJobId || job.afBatchId || job.jdBatchId || job.scoringStatus === 'scoring') {
      conflicts++;
      continue;
    }
    if (apply) {
      const result = await prisma.job.updateMany({
        where: { id: job.id, updatedAt: job.updatedAt, url: job.url, canonicalUrl: job.canonicalUrl,
          manualAts: job.manualAts, description: job.description,
          batchJobId: null, afBatchId: null, jdBatchId: null, scoringStatus: { not: 'scoring' } },
        data,
      });
      if (!result.count) { conflicts++; continue; }
    }
    changed++;
    if ('manualAts' in data) labels++;
    if ('description' in data) descriptions++;
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', candidates: candidates.length,
    changed, labels, descriptions, conflicts, unrecoveredDescriptions: unrecovered }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
