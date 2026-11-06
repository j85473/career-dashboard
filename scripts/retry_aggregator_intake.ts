import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { ingestJobs, ingestExternalJob, type ExternalJobInput } from '../src/lib/jobIngestion';
import { retryAggregatorCandidates } from '../src/lib/aggregatorIntakeQueue';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !/^--limit=\d+$/.test(arg))) throw new Error('Usage: retry_aggregator_intake.ts [--apply] [--limit=10]');
const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice(8) || 10);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error('limit must be between 1 and 25');
try {
  if (!args.includes('--apply')) {
    console.log(JSON.stringify(await prisma.aggregatorIntakeCandidate.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
      select: { id: true, company: true, title: true, reason: true, attempts: true, nextAttemptAt: true },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: limit,
    }), null, 2));
  } else {
    console.log(JSON.stringify(await retryAggregatorCandidates({ limit, ingest: async (job, context) => {
      if (context.route === 'external') {
        const input = job as ExternalJobInput;
        await ingestExternalJob({ ...input,
          postedAt: input.postedAt ? new Date(input.postedAt) : undefined,
          windowStart: input.windowStart ? new Date(input.windowStart) : null,
          windowEnd: input.windowEnd ? new Date(input.windowEnd) : null,
        }, 'pending_af', { requireCanonicalMatch: true });
        return;
      }
      await ingestJobs(undefined, undefined, undefined,
        typeof context.searchQuery === 'string' ? context.searchQuery : undefined, 'pending_af', true,
        { useStandard: false, usePaidApis: false, useCareerforce: false,
          prefetchedAggregatorCandidates: [job], requireCanonicalMatch: true,
          queryFamily: typeof context.queryFamily === 'string' ? context.queryFamily : undefined,
          geoLane: typeof context.geoLane === 'string' ? context.geoLane : undefined });
    } })));
  }
} finally { await prisma.$disconnect(); }
