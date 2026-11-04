import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from './prismaClient';
import { validateAtsV2AuthorityActive } from './atsAcquisitionCompatibility';

const gateSelection = {
  minimumWriterVersion: true, compatibilityWriterVersion: true,
  v2AuthorityActivatedAt: true, activatedLedgerVersion: true,
  legacyAcquisitionRetiredAt: true, legacyAcquisitionRetirementReleaseId: true,
} as const;
type Gate = Prisma.AtsAcquisitionRuntimeGateGetPayload<{ select: typeof gateSelection }>;
export type LegacyAtsRetirementSnapshot = {
  gate: Gate | null;
  unfinished: { unfinishedBatches: number; runningAttempts: number; convertingBatches: number; convertingBoards: number };
  workers: { matchingV2: number; otherRelease: number };
};

export function planLegacyAtsRetirement(snapshot: LegacyAtsRetirementSnapshot, releaseId: string) {
  if (!/^[a-f0-9]{40}$/.test(releaseId)) throw new Error('Use the exact deployed Git release ID.');
  const blockers: string[] = [];
  const authority = snapshot.gate ? validateAtsV2AuthorityActive(snapshot.gate) : null;
  if (!authority?.valid) blockers.push(authority?.reason || 'The acquisition runtime gate is missing.');
  for (const [kind, count] of Object.entries(snapshot.unfinished)) {
    if (count !== 0) blockers.push(`${kind}: ${count}; finish or explicitly convert saved legacy work first.`);
  }
  if (snapshot.workers.matchingV2 < 1) blockers.push('No healthy v2 acquisition worker is running the selected release.');
  if (snapshot.workers.otherRelease > 0) blockers.push('Workers from another release still hold capacity leases.');
  const retired = Boolean(snapshot.gate?.legacyAcquisitionRetiredAt);
  const selectionHash = createHash('sha256').update(JSON.stringify({ version: 1, releaseId, ...snapshot })).digest('hex');
  return { releaseId, retired, ready: !retired && blockers.length === 0, blockers, selectionHash, ...snapshot };
}

export async function readLegacyAtsRetirement(client: Prisma.TransactionClient, releaseId: string) {
  const [gate, [unfinished], [workers]] = await Promise.all([
    client.atsAcquisitionRuntimeGate.findUnique({ where: { id: 'global' }, select: gateSelection }),
    client.$queryRaw<Array<{ counts: LegacyAtsRetirementSnapshot['unfinished'] }>>`
      SELECT ats_legacy_worker_retirement_blockers() AS counts
    `,
    client.$queryRaw<Array<LegacyAtsRetirementSnapshot['workers']>>`
      SELECT count(*) FILTER (WHERE "workerKind" = 'mac-continuation' AND "releaseId" = ${releaseId})::integer AS "matchingV2",
        count(*) FILTER (WHERE "releaseId" IS DISTINCT FROM ${releaseId})::integer AS "otherRelease"
      FROM "AtsAcquisitionWorkerSlot"
      WHERE "leaseToken" IS NOT NULL AND "leaseExpiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    `,
  ]);
  return planLegacyAtsRetirement({ gate, unfinished: unfinished.counts, workers }, releaseId);
}

/** One checkpoint: an interruption commits the retirement or leaves it untouched.
 * The database guard also fences old binaries that do not know about this code. */
export async function retireLegacyAtsWorker(client: PrismaClient, releaseId: string, expectedHash: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Apply requires the selection hash from a fresh preview.');
  return client.$transaction(async transaction => {
    await transaction.$queryRaw`SELECT id FROM "AtsAcquisitionRuntimeGate" WHERE id = 'global' FOR UPDATE`;
    const plan = await readLegacyAtsRetirement(transaction, releaseId);
    if (plan.retired) return { changed: false, ...plan };
    if (plan.selectionHash !== expectedHash) throw new Error('Retirement selection changed; preview the current state again.');
    if (!plan.ready) throw new Error(plan.blockers.join(' '));
    await transaction.atsAcquisitionRuntimeGate.update({ where: { id: 'global' }, data: {
      legacyAcquisitionRetiredAt: new Date(), legacyAcquisitionRetirementReleaseId: releaseId,
    } });
    return { changed: true, ...await readLegacyAtsRetirement(transaction, releaseId) };
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 15_000 });
}
