import type { Prisma, PrismaClient } from '@prisma/client';

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
  wildcardJobs: number;
  contextRuns: number;
  standardRuns: number;
  wildcardRuns: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}>(request: T | null) {
  if (!request) return null;
  return {
    id: request.id,
    status: request.status,
    phase: request.phase,
    source: request.source,
    progress: request.progress,
    error: request.error,
    counts: {
      context: request.contextJobs,
      standard: request.standardJobs,
      wildcard: request.wildcardJobs,
    },
    runs: {
      context: request.contextRuns,
      standard: request.standardRuns,
      wildcard: request.wildcardRuns,
    },
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    completedAt: request.completedAt?.toISOString() || null,
  };
}
