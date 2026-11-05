import { atsLedgerHash } from './atsEvidenceHash';

type RawObject = Record<string, unknown>;
type Item = {
  id?: string; batchId?: string; rawJson: unknown; rawHash?: string; rawReference?: unknown;
  representativeObservationId?: string | null;
  representativeObservation?: { id: string; batchId: string; rawHash: string; rawJson: unknown } | null;
};

export function resolveAtsItemRaw(item: Item): RawObject {
  if (item.rawJson && typeof item.rawJson === 'object' && !Array.isArray(item.rawJson)) return item.rawJson as RawObject;
  const reference = item.rawReference as RawObject | null;
  const observation = item.representativeObservation;
  if (reference?.version !== 1 || reference?.type !== 'observation' || !observation
    || reference.observationId !== item.representativeObservationId || observation.id !== reference.observationId
    || observation.batchId !== item.batchId || reference.rawHash !== item.rawHash || observation.rawHash !== item.rawHash
    || !observation.rawJson || typeof observation.rawJson !== 'object' || Array.isArray(observation.rawJson)
    || atsLedgerHash(observation.rawJson) !== item.rawHash) {
    throw new Error(`Missing or divergent immutable ATS raw evidence for item ${item.id || 'unknown'}.`);
  }
  return observation.rawJson as RawObject;
}
