import { prisma } from './prisma';

/**
 * Version 2 introduced the dormant expand-only schema and cross-version fence.
 * Version 3 is the first binary that can write row-granular v2 pages/items and
 * the transaction-capability-fenced v2 lifecycle summaries. Activation must
 * raise the durable minimum to 3 only after every acquisition worker runs it.
 */
export const ATS_ACQUISITION_WRITER_VERSION = 3;

export type AtsAcquisitionRuntimeGateState = {
  minimumWriterVersion: number;
  compatibilityWriterVersion: number;
  v2AuthorityActivatedAt: Date | null;
  activatedLedgerVersion: number | null;
};

export function validateAtsAcquisitionWriterCompatibility(
  gate: AtsAcquisitionRuntimeGateState | null,
  writerVersion = ATS_ACQUISITION_WRITER_VERSION,
): { valid: true } | { valid: false; reason: string } {
  if (!gate) {
    return {
      valid: false,
      reason: 'ATS acquisition runtime gate is missing; the additive Phase 1 migration is not ready.',
    };
  }
  if (!Number.isInteger(writerVersion) || writerVersion < gate.minimumWriterVersion) {
    return {
      valid: false,
      reason: `ATS acquisition writer ${writerVersion} is older than durable minimum ${gate.minimumWriterVersion}.`,
    };
  }
  if (gate.v2AuthorityActivatedAt && writerVersion < gate.compatibilityWriterVersion) {
    return {
      valid: false,
      reason: `ATS v2 authority is active and requires compatibility writer ${gate.compatibilityWriterVersion} or newer.`,
    };
  }
  return { valid: true };
}

export async function assertAtsAcquisitionWriterCompatibility(): Promise<AtsAcquisitionRuntimeGateState> {
  const gate = await prisma.atsAcquisitionRuntimeGate.findUnique({
    where: { id: 'global' },
    select: {
      minimumWriterVersion: true,
      compatibilityWriterVersion: true,
      v2AuthorityActivatedAt: true,
      activatedLedgerVersion: true,
    },
  });
  const validation = validateAtsAcquisitionWriterCompatibility(gate);
  if (!validation.valid) throw new Error(validation.reason);
  if (!gate) throw new Error('ATS acquisition runtime gate disappeared during compatibility validation.');
  return gate;
}

export function validateAtsV2AuthorityActive(
  gate: AtsAcquisitionRuntimeGateState,
): { valid: true } | { valid: false; reason: string } {
  if (!gate.v2AuthorityActivatedAt
    || (gate.activatedLedgerVersion || 0) < 2
    || gate.minimumWriterVersion < ATS_ACQUISITION_WRITER_VERSION
    || gate.compatibilityWriterVersion < ATS_ACQUISITION_WRITER_VERSION) {
    return {
      valid: false,
      reason: 'ATS v2 flags require the durable writer-3/ledger-2 authority gate to be active.',
    };
  }
  return { valid: true };
}

export async function assertAtsV2AuthorityActive(): Promise<AtsAcquisitionRuntimeGateState> {
  const gate = await assertAtsAcquisitionWriterCompatibility();
  const validation = validateAtsV2AuthorityActive(gate);
  if (!validation.valid) throw new Error(validation.reason);
  return gate;
}
