import { randomUUID } from 'node:crypto';
import { Prisma } from './prismaClient';
import { prisma } from './prisma';
import type { IncomingJob } from './jobIngestion';

const RETRY_BASE_MS = 10 * 60_000;
export const aggregatorIntakeRetryAt = (attempts: number, now: Date): Date =>
  new Date(now.getTime() + Math.min(6 * 60 * 60_000, RETRY_BASE_MS * 2 ** Math.min(6, Math.max(0, attempts - 1))));

export async function retainAggregatorCandidate(input: {
  job: IncomingJob; source: string; sourceId: string; title: string; company: string; url: string;
  reason: string; expired: boolean; context: Record<string, unknown>;
}, store = prisma, now = new Date()): Promise<void> {
  const payload = input.expired ? Prisma.DbNull : JSON.parse(JSON.stringify(input.job));
  const data = { title: input.title, company: input.company, url: input.url, payload,
    context: JSON.parse(JSON.stringify(input.context)), reason: input.reason,
    status: input.expired ? 'expired' : 'pending', lastCheckedAt: now, lastError: null };
  await store.aggregatorIntakeCandidate.upsert({
    where: { source_sourceId: { source: input.source, sourceId: input.sourceId } },
    create: { ...data, source: input.source, sourceId: input.sourceId, nextAttemptAt: aggregatorIntakeRetryAt(1, now) },
    // Rediscovery refreshes evidence without postponing a scheduled retry or
    // stealing its lease. This table has no scoring or Job lifecycle authority.
    update: data,
  });
}

/** Bounded durable retries; a competing worker cannot process the same lease. */
export async function retryAggregatorCandidates(input: {
  limit: number;
  ingest: (job: IncomingJob, context: Record<string, unknown>) => Promise<void>;
}, store = prisma, now = new Date()): Promise<{ attempted: number; released: number; pending: number; expired: number }> {
  const available = { status: 'pending', nextAttemptAt: { lte: now },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] };
  const candidates = await store.aggregatorIntakeCandidate.findMany({
    where: available, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: input.limit,
  });
  const result = { attempted: 0, released: 0, pending: 0, expired: 0 };
  for (const candidate of candidates) {
    const token = randomUUID();
    const claimed = await store.aggregatorIntakeCandidate.updateMany({
      where: { id: candidate.id, ...available },
      data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 10 * 60_000), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    result.attempted++;
    let error: string | null = null;
    try {
      if (!candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) throw new Error('Missing retained aggregator payload');
      await input.ingest(candidate.payload as IncomingJob,
        candidate.context && typeof candidate.context === 'object' && !Array.isArray(candidate.context) ? candidate.context : {});
    } catch (caught) { error = String(caught).slice(0, 500); }
    const observation = await store.jobSourceObservation.findUnique({
      where: { source_sourceId: { source: candidate.source, sourceId: candidate.sourceId } }, select: { jobId: true },
    });
    const current = await store.aggregatorIntakeCandidate.findUnique({ where: { id: candidate.id }, select: { status: true } });
    const status = observation ? 'released' : current?.status === 'expired' ? 'expired' : 'pending';
    await store.aggregatorIntakeCandidate.updateMany({
      where: { id: candidate.id, leaseToken: token },
      data: { status, leaseToken: null, leaseExpiresAt: null, lastError: error,
        nextAttemptAt: aggregatorIntakeRetryAt(candidate.attempts + 1, new Date()),
        ...(observation ? { jobId: observation.jobId, payload: Prisma.DbNull } : {}) },
    });
    result[status === 'released' ? 'released' : status === 'expired' ? 'expired' : 'pending']++;
  }
  return result;
}
