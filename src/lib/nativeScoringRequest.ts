import type { Prisma, PrismaClient } from '@prisma/client';

import { nativeScoringLeaseExpired } from './nativeScoringLease';
import { prisma } from './prisma';

export const ACTIVE_NATIVE_SCORING_KEY = 'global';
export const NATIVE_SCORING_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type NativeScoringRequestClient = Pick<PrismaClient, 'nativeScoringRequest'>;

function safeSource(source: string): string {
  const normalized = source.trim().slice(0, 80);
  if (!/^[a-z0-9_-]+$/i.test(normalized)) {
    throw new Error('Native scoring request source contains unsafe characters');
  }
  return normalized;
}

export async function latestNativeScoringRequest(client: NativeScoringRequestClient = prisma) {
  return client.nativeScoringRequest.findFirst({ orderBy: { createdAt: 'desc' } });
}

export async function activeNativeScoringRequest(client: NativeScoringRequestClient = prisma) {
  return client.nativeScoringRequest.findUnique({ where: { activeKey: ACTIVE_NATIVE_SCORING_KEY } });
}

export async function createNativeScoringRequest(
  source: string,
  client: NativeScoringRequestClient = prisma,
) {
  const existing = await activeNativeScoringRequest(client);
  if (existing?.status === 'failed') {
    return {
      request: await retryNativeScoringRequest(existing.id, client),
      created: false,
      resumed: true,
    };
  }
  if (existing) return { request: existing, created: false, resumed: false };

  try {
    const request = await client.nativeScoringRequest.create({
      data: {
        activeKey: ACTIVE_NATIVE_SCORING_KEY,
        source: safeSource(source),
      },
    });
    return { request, created: true, resumed: false };
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'P2002'
    ) {
      const winner = await activeNativeScoringRequest(client);
      if (winner) return { request: winner, created: false, resumed: false };
    }
    throw error;
  }
}

export async function retryNativeScoringRequest(
  id: string,
  client: NativeScoringRequestClient = prisma,
) {
  const current = await client.nativeScoringRequest.findUnique({ where: { id } });
  if (!current) throw new Error('Native scoring request not found');
  if (current.status !== 'failed') throw new Error('Only failed native scoring requests can be retried');
  const active = await activeNativeScoringRequest(client);
  if (active && active.id !== id) throw new Error('Another native scoring request is already active');

  return client.nativeScoringRequest.update({
    where: { id },
    data: {
      activeKey: ACTIVE_NATIVE_SCORING_KEY,
      status: 'queued',
      error: null,
      workerId: null,
      claimedAt: null,
      heartbeatAt: null,
      completedAt: null,
      progress: 'Retry queued for the local Antigravity runner.',
    },
  });
}

/**
 * Releases the single-flight slot so a stranded request can never lock the
 * dashboard out of scoring. A `queued` request has no worker and is always safe
 * to drop; a `running` one is only safe once its lease has expired, otherwise a
 * live runner would keep writing to a request the dashboard considers finished.
 */
export async function cancelNativeScoringRequest(
  id: string,
  client: NativeScoringRequestClient = prisma,
) {
  const current = await client.nativeScoringRequest.findUnique({ where: { id } });
  if (!current) throw new Error('Native scoring request not found');
  if ((NATIVE_SCORING_TERMINAL_STATUSES as readonly string[]).includes(current.status)) {
    throw new Error('This native scoring request has already finished');
  }
  if (current.status === 'running' && !nativeScoringLeaseExpired(current)) {
    throw new Error('The local Antigravity runner is still sending heartbeats. Stop the runner before cancelling.');
  }

  // Guarded on the row the check above read, so a watcher claiming the request
  // at the same moment wins instead of being cancelled out from under itself.
  const cancelled = await client.nativeScoringRequest.updateMany({
    where: { id, status: current.status, updatedAt: current.updatedAt },
    data: {
      activeKey: null,
      status: 'cancelled',
      error: null,
      progress: 'Native scoring was cancelled from the dashboard.',
      completedAt: new Date(),
    },
  });
  if (cancelled.count !== 1) {
    throw new Error('The native scoring request changed while it was being cancelled. Refresh and try again.');
  }

  const request = await client.nativeScoringRequest.findUnique({ where: { id } });
  if (!request) throw new Error('Native scoring request not found');
  return request;
}

export async function updateNativeScoringRequest(
  id: string,
  data: Prisma.NativeScoringRequestUpdateInput,
  client: NativeScoringRequestClient = prisma,
) {
  return client.nativeScoringRequest.update({ where: { id }, data });
}

export function publicNativeScoringRequest<T extends {
  id: string;
  status: string;
  phase: string;
  source: string;
  progress: string;
  error: string | null;
  contextJobs: number;
  standardJobs: number;
  contextRuns: number;
  standardRuns: number;
  chunksTotal: number;
  chunksDone: number;
  quarantineRetries: number;
  quarantineChunks: number;
  attempt: number;
  heartbeatAt: Date | null;
  claimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}>(request: T | null, now: number = Date.now()) {
  if (!request) return null;
  const startedAt = request.claimedAt || request.createdAt;
  return {
    id: request.id,
    status: request.status,
    phase: request.phase,
    source: request.source,
    progress: request.progress,
    error: request.error,
    // Server-side so the dashboard never judges the lease against a skewed clock.
    stalled: nativeScoringLeaseExpired(request),
    counts: {
      context: request.contextJobs,
      standard: request.standardJobs,
    },
    runs: {
      context: request.contextRuns,
      standard: request.standardRuns,
    },
    attempt: request.attempt,
    // Published by the local watcher; zeroed until it reports a manifest.
    chunks: {
      total: request.chunksTotal,
      done: Math.min(request.chunksDone, request.chunksTotal),
      quarantineRetries: request.quarantineRetries,
      quarantineChunks: request.quarantineChunks,
    },
    // Ages resolved server-side, for the same reason as `stalled`.
    elapsedMs: Math.max(0, now - startedAt.getTime()),
    lastUpdateMs: Math.max(0, now - request.updatedAt.getTime()),
    heartbeatAgeMs: request.heartbeatAt ? Math.max(0, now - request.heartbeatAt.getTime()) : null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    completedAt: request.completedAt?.toISOString() || null,
  };
}
