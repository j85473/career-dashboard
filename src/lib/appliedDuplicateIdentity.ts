import type { Prisma } from '@prisma/client';

import { generateV4Fingerprint } from './jobIngestion';
import {
  isAppliedDuplicateAuthorityEvidence,
  isUnreliableLocation,
} from './appliedDuplicatePolicy';

export type ProtectedAppliedIdentityCandidate = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  status: string;
  passReason: string | null;
  identityFingerprint: string | null;
  updatedAt: Date;
};

export type ProtectedAppliedIdentityBackfillPlan = {
  id: string;
  identityFingerprint: string;
  expectedTitle: string;
  expectedCompany: string;
  expectedLocation: string | null;
  expectedStatus: string;
  expectedPassReason: string | null;
  expectedUpdatedAt: Date;
};

export type ProtectedAppliedIdentityBackfillPreview = {
  plans: ProtectedAppliedIdentityBackfillPlan[];
  skippedUnreliableLocationIds: string[];
};

type BackfillStore = Pick<Prisma.TransactionClient, 'job'>;

export function appliedIdentityFingerprint(input: {
  title: string;
  company: string;
  location: string | null | undefined;
}): string {
  return generateV4Fingerprint(input.title, input.company, input.location || '');
}

export function shouldMaintainAppliedIdentity(input: {
  status: string | null | undefined;
  passReason: string | null | undefined;
  identityInputChanged: boolean;
  currentIdentityFingerprint: string | null | undefined;
}): boolean {
  const protectedEvidence = isAppliedDuplicateAuthorityEvidence({
    status: String(input.status || ''),
    passReason: input.passReason,
  });
  if (protectedEvidence) return true;

  // Editing a row that already participates in identity lookup must refresh
  // its key. An edit must not, however, create the first fingerprint for a
  // historical Passed/Cooldown row and thereby activate evidence Joseph
  // explicitly excluded from the backfill.
  return input.identityInputChanged && Boolean(input.currentIdentityFingerprint);
}

/**
 * Produces a zero-write plan for the explicitly approved historical cohort.
 * Passed and Cooldown rows are deliberately excluded because only affirmative
 * application evidence may authorize suppression.
 */
export function planProtectedAppliedIdentityBackfill(
  candidates: readonly ProtectedAppliedIdentityCandidate[],
): ProtectedAppliedIdentityBackfillPreview {
  const plans: ProtectedAppliedIdentityBackfillPlan[] = [];
  const skippedUnreliableLocationIds: string[] = [];

  for (const candidate of candidates) {
    if (candidate.identityFingerprint || !isAppliedDuplicateAuthorityEvidence(candidate)) continue;
    if (isUnreliableLocation(candidate.location)) {
      skippedUnreliableLocationIds.push(candidate.id);
      continue;
    }
    plans.push({
      id: candidate.id,
      identityFingerprint: appliedIdentityFingerprint(candidate),
      expectedTitle: candidate.title,
      expectedCompany: candidate.company,
      expectedLocation: candidate.location,
      expectedStatus: candidate.status,
      expectedPassReason: candidate.passReason,
      expectedUpdatedAt: candidate.updatedAt,
    });
  }

  return { plans, skippedUnreliableLocationIds };
}

/**
 * Applies only a previously reviewed preview. Every mutable identity/evidence
 * field, updatedAt, and the expected NULL fingerprint are repeated in the
 * write predicate, so a concurrent edit or lifecycle transition refuses the
 * row instead of silently applying a stale plan.
 */
export async function applyProtectedAppliedIdentityBackfill(
  plans: readonly ProtectedAppliedIdentityBackfillPlan[],
  store: BackfillStore,
): Promise<{ appliedIds: string[]; refusedIds: string[] }> {
  const appliedIds: string[] = [];
  const refusedIds: string[] = [];

  for (const plan of plans) {
    const result = await store.job.updateMany({
      where: {
        id: plan.id,
        identityFingerprint: null,
        title: plan.expectedTitle,
        company: plan.expectedCompany,
        location: plan.expectedLocation,
        status: plan.expectedStatus,
        passReason: plan.expectedPassReason,
        updatedAt: plan.expectedUpdatedAt,
      },
      data: { identityFingerprint: plan.identityFingerprint },
    });
    if (result.count === 1) appliedIds.push(plan.id);
    else refusedIds.push(plan.id);
  }

  return { appliedIds, refusedIds };
}
