import assert from 'node:assert/strict';
import test from 'node:test';

import { typedContextRule } from '../contextFeedbackPolicy';
import { materializeTypedContextRules } from '../contextRuleMaterialization';

test('typed Context materialization preserves stable identity, provenance, and retires absent rules', async () => {
  const rule = typedContextRule('Inside sales roles');
  const upserts: Array<Record<string, unknown>> = [];
  let retirementWhere: unknown;
  const tx = {
    contextRule: {
      findMany: async () => [{
        ruleKey: rule.id,
        active: false,
        dimension: rule.dimension,
        scope: rule.scope,
        ruleText: rule.text,
        sourceDecisionIds: ['old-decision'],
        confidence: 0.8,
      }],
      upsert: async (args: Record<string, unknown>) => {
        upserts.push(args);
        return {};
      },
      updateMany: async (args: { where: unknown }) => {
        retirementWhere = args.where;
        return { count: 2 };
      },
    },
  };

  const result = await materializeTypedContextRules(
    tx as never,
    'global',
    [rule],
    {
      source: 'native-context-evaluator',
      requestId: 'request-1',
      batchId: 'batch-1',
      promptVersion: 'context-v1',
      sourceDecisionIds: ['new-decision'],
      confidence: 1,
      confirmedAt: new Date('2026-08-09T12:00:00.000Z'),
    },
  );

  assert.deepEqual(result, { active: 1, retired: 2 });
  assert.equal((upserts[0].where as { ruleKey: string }).ruleKey, rule.id);
  assert.deepEqual(
    (upserts[0].update as { sourceDecisionIds: string[] }).sourceDecisionIds,
    ['old-decision', 'new-decision'],
  );
  assert.deepEqual(
    retirementWhere,
    { contextProfileId: 'global', active: true, ruleKey: { notIn: [rule.id] } },
  );
});

test('unchanged active Context rules are confirmed without absorbing unrelated batch decisions', async () => {
  const rule = typedContextRule('Inside sales roles');
  const updates: Array<Record<string, unknown>> = [];
  let upsertCount = 0;
  const tx = {
    contextRule: {
      findMany: async () => [{
        ruleKey: rule.id,
        active: true,
        dimension: rule.dimension,
        scope: rule.scope,
        ruleText: rule.text,
        sourceDecisionIds: ['originating-decision'],
        confidence: 0.8,
      }],
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return {};
      },
      upsert: async () => {
        upsertCount += 1;
        return {};
      },
      updateMany: async () => ({ count: 0 }),
    },
  };

  await materializeTypedContextRules(tx as never, 'global', [rule], {
    source: 'native-context-evaluator',
    batchId: 'batch-2',
    promptVersion: 'context-v2',
    sourceDecisionIds: ['unrelated-batch-decision'],
    confirmedAt: new Date('2026-08-09T13:00:00.000Z'),
  });

  assert.equal(upsertCount, 0);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, { ruleKey: rule.id });
  assert.deepEqual(Object.keys(updates[0].data as object), ['lastConfirmedAt']);
});

test('new Context rules retain only their claim-level source decisions', async () => {
  const insideSales = typedContextRule('Inside sales roles');
  const coldProspecting = typedContextRule('Roles dominated by cold prospecting');
  const creates: Array<Record<string, unknown>> = [];
  const tx = {
    contextRule: {
      findMany: async () => [],
      upsert: async (args: { create: Record<string, unknown> }) => {
        creates.push(args.create);
        return {};
      },
      updateMany: async () => ({ count: 0 }),
    },
  };

  await materializeTypedContextRules(tx as never, 'global', [insideSales, coldProspecting], {
    source: 'native-context-evaluator',
    batchId: 'batch-3',
    promptVersion: 'context-v3',
    sourceDecisionIdsByRuleKey: new Map([
      [insideSales.id, ['inside-sales-decision']],
      [coldProspecting.id, ['cold-prospecting-decision']],
    ]),
    confirmedAt: new Date('2026-08-09T14:00:00.000Z'),
  });

  assert.deepEqual(creates.map((create) => ({
    ruleKey: create.ruleKey,
    sourceDecisionIds: create.sourceDecisionIds,
  })), [
    { ruleKey: insideSales.id, sourceDecisionIds: ['inside-sales-decision'] },
    { ruleKey: coldProspecting.id, sourceDecisionIds: ['cold-prospecting-decision'] },
  ]);
});
