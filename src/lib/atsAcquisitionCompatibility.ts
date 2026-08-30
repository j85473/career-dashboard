import { prisma } from './prisma';

/**
 * Version 2 is the first binary that understands the expand-only acquisition
 * ledger and honors AtsCompany.acquisitionEngine/AtsIngestionBatch.writerMode.
 * Phase 1 leaves the durable minimum at 1; the later v2 activation CAS raises
 * it only after every acquisition worker runs this compatibility writer.
 */
export const ATS_ACQUISITION_WRITER_VERSION = 2;

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
