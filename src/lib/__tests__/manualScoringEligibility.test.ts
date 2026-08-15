import assert from 'node:assert/strict';
import test from 'node:test';

import { manualScoringStatusWhere } from '../manualScoringEligibility';

test('Aim admits an explicitly requeued pending job without reopening the dormant backlog', () => {
  assert.deepEqual(manualScoringStatusWhere('aim'), {
    status: 'pending_af',
    OR: [
      {
        NOT: [
          { fitCategory: 'promoted' },
          { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } },
          { pipelineEvents: { some: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } } } },
        ],
      },
      { pipelineEvents: { some: { eventType: 'user_rescore' } } },
    ],
  });
});

test('Experience keeps the explicitly requeued job pending until E Fit completes', () => {
  assert.deepEqual(manualScoringStatusWhere('experience'), {
    status: 'pending_af',
    OR: [
      { pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } } } },
      { pipelineEvents: { some: { eventType: 'user_rescore' } } },
    ],
  });
});
