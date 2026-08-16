import type { Prisma } from '@prisma/client';

/**
 * Aim consumes the strongest local survivors first. Recency breaks equal-score
 * ties, while ID makes pagination and export ordinals deterministic when both
 * business fields are identical.
 */
export function aimScoringPriorityOrder(): Prisma.JobOrderByWithRelationInput[] {
  return [
    { fitScore: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
    { id: 'asc' },
  ];
}
