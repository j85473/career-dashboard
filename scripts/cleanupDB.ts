import { prisma } from "../src/lib/prisma";
import { passesPreFilter } from "../src/lib/jobFiltering";
import { generateFingerprint, generateV2Fingerprint, isLikelyDuplicatePosting, normalizeUrl } from "../src/lib/jobIngestion";
import * as crypto from "crypto";

function generateLegacyFingerprint(title: string, company: string, stripCompanySuffix = true): string {
  const normalize = (value: string) => {
    let normalized = (value || '').toLowerCase();
    normalized = normalized.replace(/[,\-|(].*(mn|minnesota|remote|usa|st\.?\s*paul|twin cities|minneapolis|woodbury|apple valley|edina|plymouth|maple grove).*/gi, '');
    if (stripCompanySuffix) {
      normalized = normalized.replace(/\b(?:incorporated|corporation|company|limited|inc|corp|llc|ltd)\b\.?/g, '');
    }
    return normalized.replace(/[^a-z0-9]/g, '');
  };
  return crypto.createHash('md5').update(`${normalize(company)}|${normalize(title)}`).digest('hex');
}

async function findDuplicate(input: any) {
  const title = input.title || '';
  const company = input.company || '';
  const location = input.location || '';
  const canonicalUrl = normalizeUrl(input.canonicalUrl || input.url || '');
  const oldLocations = [location, 'unknown', 'remote', 'mn', 'st paul', 'us'];
  const fingerprints = [
    generateFingerprint(title, company),
    ...oldLocations.map(loc => generateV2Fingerprint(title, company, loc)),
    generateLegacyFingerprint(title, company),
    generateLegacyFingerprint(title, company, false),
  ];
  const recentCutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  
  const candidates = await prisma.job.findMany({
    where: {
      id: { not: input.id },
      createdAt: { gte: recentCutoff },
      OR: [
        ...(canonicalUrl ? [{ canonicalUrl }] : []),
        { fingerprint: { in: fingerprints } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return candidates.find((candidate) => isLikelyDuplicatePosting(candidate as any, input)) || null;
}

async function main() {
  console.log("Starting Phase 2 DB Cleanup...");

  // 1. Process queued jobs (DeepSeek queue) for heuristics
  console.log("Fetching 'queued' jobs...");
  const queuedJobs = await prisma.job.findMany({
    where: { scoringStatus: 'queued', status: { in: ['inbox', 'pending_af'] } },
    select: { id: true, title: true, company: true, description: true, location: true, url: true }
  });
  
  console.log(`Found ${queuedJobs.length} queued jobs to check.`);
  let archivedQueuedCount = 0;
  for (const job of queuedJobs) {
    const filter = passesPreFilter(job as any);
    if (!filter.passes) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'archived',
          passReason: filter.reason,
          scoringStatus: 'skipped',
        }
      });
      archivedQueuedCount++;
    }
  }
  console.log(`Archived ${archivedQueuedCount} junk jobs from queued (DeepSeek).`);

  // 2. Process needs_jd jobs (Jina queue) for heuristics AND deduplication
  console.log("Fetching 'needs_jd' jobs...");
  const needsJdJobs = await prisma.job.findMany({
    where: { scoringStatus: 'needs_jd', status: { in: ['inbox', 'pending_af'] } },
    select: { id: true, title: true, company: true, description: true, location: true, url: true, canonicalUrl: true, source: true, sourceId: true }
  });

  console.log(`Found ${needsJdJobs.length} needs_jd jobs to check.`);
  let archivedNeedsJdCount = 0;
  let deletedDuplicatesCount = 0;
  
  for (const job of needsJdJobs) {
    const filter = passesPreFilter(job as any);
    if (!filter.passes) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'archived',
          passReason: filter.reason,
          scoringStatus: 'skipped',
        }
      });
      archivedNeedsJdCount++;
      continue;
    }

    const duplicate = await findDuplicate(job);
    if (duplicate) {
      await prisma.job.delete({ where: { id: job.id } });
      deletedDuplicatesCount++;
    }
  }

  console.log(`Archived ${archivedNeedsJdCount} junk jobs from needs_jd.`);
  console.log(`Deleted ${deletedDuplicatesCount} duplicate jobs from needs_jd.`);
  console.log("Phase 2 DB Cleanup Complete.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
