import {
  recordAtsCutoverReceipt,
  readAtsCutoverReadiness,
  readAtsZeroJobFailureResolutionPlan,
  recordAtsZeroJobFailureResolutions,
} from '../src/lib/atsCutoverReadiness';
import { readAtsCoordinationGate } from '../src/lib/atsAcquisitionCoordination';
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');
const BEGIN_DRAIN = process.argv.includes('--begin-drain');
const REOPEN = process.argv.includes('--reopen');
const RECORD = process.argv.includes('--record');
const ACTIVATE = process.argv.includes('--activate');
const RESOLVE_ZERO_JOB_FAILURES = process.argv.includes('--resolve-zero-job-failures');

function valueAfter(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

async function main(): Promise<void> {
  const selectedActions = [
    BEGIN_DRAIN,
    REOPEN,
    RECORD,
    ACTIVATE,
    RESOLVE_ZERO_JOB_FAILURES,
  ].filter(Boolean).length;
  if (selectedActions > 1) throw new Error('Choose only one cutover action at a time.');

  if (RESOLVE_ZERO_JOB_FAILURES) {
    const expectedHash = valueAfter('--expected-selection-hash');
    const plan = await readAtsZeroJobFailureResolutionPlan();
    if (!APPLY) {
      console.log(JSON.stringify({
        apply: false,
        action: 'resolve-zero-job-failures',
        plan,
      }));
      return;
    }
    if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
      throw new Error(
        '--resolve-zero-job-failures --apply requires --expected-selection-hash from a fresh dry-run result.',
      );
    }
    const result = await recordAtsZeroJobFailureResolutions(expectedHash.toLowerCase());
    console.log(JSON.stringify({
      apply: true,
      action: 'resolve-zero-job-failures',
      result,
    }));
    return;
  } else if (BEGIN_DRAIN) {
    if (!APPLY) {
      console.log(JSON.stringify({ apply: false, action: 'begin-drain', gate: await readAtsCoordinationGate() }));
      return;
    }
    const [gate, preflight] = await Promise.all([
      readAtsCoordinationGate(),
      readAtsCutoverReadiness(),
    ]);
    if (gate?.cutoverReadyAt) {
      throw new Error('A recorded clean-cutover boundary cannot be replaced by a new drain.');
    }
    if (preflight.snapshot.confirmedContacts < preflight.snapshot.dailyTarget) {
      throw new Error(
        `Drain requires the daily coverage target first; observed ${preflight.snapshot.confirmedContacts}/${preflight.snapshot.dailyTarget}.`,
      );
    }
    await prisma.atsAcquisitionRuntimeGate.update({
      where: { id: 'global' },
      data: { admissionState: 'draining', admissionResumeAt: null, drainRequestedAt: new Date(), cutoverReadyAt: null },
    });
  } else if (REOPEN) {
    const gate = await readAtsCoordinationGate();
    if (gate?.cutoverReadyAt) {
      throw new Error('Admissions cannot reopen after a recorded clean cutover boundary.');
    }
    if (!APPLY) {
      console.log(JSON.stringify({ apply: false, action: 'reopen', gate }));
      return;
    }
    await prisma.atsAcquisitionRuntimeGate.update({
      where: { id: 'global' },
      data: { admissionState: 'open', admissionResumeAt: null, drainRequestedAt: null },
    });
  } else if (RECORD) {
    const expectedHash = valueAfter('--expected-hash');
    if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
      throw new Error('--record requires --expected-hash from a fresh read-only status result.');
    }
    if (!APPLY) {
      console.log(JSON.stringify({ apply: false, action: 'record', expectedHash }));
      return;
    }
    const receipt = await recordAtsCutoverReceipt(expectedHash.toLowerCase());
    console.log(JSON.stringify({ apply: true, action: 'record', receipt }));
    return;
  } else if (ACTIVATE) {
    if (!APPLY) {
      console.log(JSON.stringify({
        apply: false,
        action: 'activate',
        gate: await readAtsCoordinationGate(),
      }));
      return;
    }
    const releaseId = process.env.ATS_WORKER_RELEASE_ID || '';
    if (!/^[a-f0-9]{40}$/i.test(releaseId)) {
      throw new Error('ATS architecture activation requires the exact deployed Git release ID.');
    }
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(912837466)`;
      const gate = await transaction.atsAcquisitionRuntimeGate.findUnique({
        where: { id: 'global' },
      });
      if (!gate?.cutoverReadyAt) {
        throw new Error('ATS architecture activation requires a recorded clean-cutover boundary.');
      }
      if (!gate.distributedAuthorityActivatedAt || !gate.remoteWorkersEnabled) {
        throw new Error('ATS architecture activation requires distributed and remote authority.');
      }
      const now = new Date();
      const [piSlots, macSlots] = await Promise.all([
        transaction.atsAcquisitionWorkerSlot.count({
          where: {
            workerKind: 'pi-acquisition',
            releaseId,
            leaseToken: { not: null },
            leaseExpiresAt: { gt: now },
          },
        }),
        transaction.atsAcquisitionWorkerSlot.count({
          where: {
            workerKind: 'mac-continuation',
            releaseId,
            leaseToken: { not: null },
            leaseExpiresAt: { gt: now },
          },
        }),
      ]);
      if (piSlots !== gate.localSlotReserve || macSlots < 1) {
        throw new Error(
          `ATS activation requires ${gate.localSlotReserve} healthy Pi slots and at least one Mac slot; observed ${piSlots} Pi and ${macSlots} Mac.`,
        );
      }
      await transaction.atsAcquisitionRuntimeGate.update({
        where: { id: 'global' },
        data: { admissionState: 'open', admissionResumeAt: null, drainRequestedAt: null },
      });
    });
  }

  const [gate, readiness] = await Promise.all([
    readAtsCoordinationGate(),
    readAtsCutoverReadiness(),
  ]);
  console.log(JSON.stringify({ apply: APPLY, gate, readiness }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
