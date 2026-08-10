import type { Prisma } from '@prisma/client';

import type { TypedContextRule } from './contextFeedbackPolicy';

export type ContextRuleMaterializationMetadata = {
  source: 'legacy-normalizer' | 'native-context-evaluator' | 'legacy-migration';
  requestId?: string | null;
  batchId?: string | null;
  promptVersion: string;
  sourceDecisionIds?: string[];
  sourceDecisionIdsByRuleKey?: ReadonlyMap<string, readonly string[]>;
  confidence?: number | null;
  confirmedAt?: Date;
};

/**
 * Atomically makes typed Context rows an exact active materialization of the
 * already-validated profile. Call this inside the same transaction that writes
 * ContextProfile.rulesText and its immutable revision.
 */
export async function materializeTypedContextRules(
  tx: Prisma.TransactionClient,
  contextProfileId: string,
  rules: TypedContextRule[],
  metadata: ContextRuleMaterializationMetadata,
): Promise<{ active: number; retired: number }> {
  const existingRules = await tx.contextRule.findMany({ where: { contextProfileId } });
  const existingRulesByKey = new Map(existingRules.map((rule) => [rule.ruleKey, rule]));
  const confirmedAt = metadata.confirmedAt || new Date();

  for (const rule of rules) {
    const existingRule = existingRulesByKey.get(rule.id);
    const sourceDecisionIds = metadata.sourceDecisionIdsByRuleKey?.get(rule.id)
      ? [...(metadata.sourceDecisionIdsByRuleKey.get(rule.id) || [])]
      : (metadata.sourceDecisionIds || []);
    const materiallyUnchanged = Boolean(
      existingRule
      && existingRule.active
      && existingRule.dimension === rule.dimension
      && existingRule.scope === rule.scope
      && existingRule.ruleText.trim() === rule.text.trim()
    );
    if (materiallyUnchanged && existingRule) {
      await tx.contextRule.update({
        where: { ruleKey: rule.id },
        data: { lastConfirmedAt: confirmedAt },
      });
      continue;
    }
    const mergedSourceDecisionIds = [...new Set([
      ...(existingRule?.sourceDecisionIds || []),
      ...sourceDecisionIds,
    ])];
    const provenance = {
      source: metadata.source,
      requestId: metadata.requestId || null,
      batchId: metadata.batchId || null,
      promptVersion: metadata.promptVersion,
    } as Prisma.InputJsonValue;
    await tx.contextRule.upsert({
      where: { ruleKey: rule.id },
      create: {
        contextProfileId,
        ruleKey: rule.id,
        dimension: rule.dimension,
        scope: rule.scope,
        ruleText: rule.text,
        sourceDecisionIds: mergedSourceDecisionIds,
        confidence: metadata.confidence ?? null,
        active: true,
        lastConfirmedAt: confirmedAt,
        provenance,
      },
      update: {
        dimension: rule.dimension,
        scope: rule.scope,
        ruleText: rule.text,
        sourceDecisionIds: mergedSourceDecisionIds,
        confidence: metadata.confidence ?? existingRule?.confidence ?? null,
        active: true,
        lastConfirmedAt: confirmedAt,
        retiredAt: null,
        retiredReason: null,
        provenance,
      },
    });
  }

  const activeKeys = rules.map((rule) => rule.id);
  const retired = await tx.contextRule.updateMany({
    where: {
      contextProfileId,
      active: true,
      ...(activeKeys.length > 0 ? { ruleKey: { notIn: activeKeys } } : {}),
    },
    data: {
      active: false,
      retiredAt: confirmedAt,
      retiredReason: `Superseded by ${metadata.source} (${metadata.batchId || metadata.requestId || metadata.promptVersion})`,
    },
  });
  return { active: rules.length, retired: retired.count };
}
