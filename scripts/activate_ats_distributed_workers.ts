import {
  ATS_DISTRIBUTED_WORKER_VERSION,
  ATS_DISTRIBUTED_WORKERS_ENABLED,
  ATS_PI_LOCAL_SLOT_RESERVE,
  readAtsCoordinationGate,
  validateAtsCoordinationGate,
} from '../src/lib/atsAcquisitionCoordination';
import { assertAtsV2AuthorityActive } from '../src/lib/atsAcquisitionCompatibility';
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');
const DISABLE = process.argv.includes('--disable');

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] || '', 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} requires an integer.`);
  return parsed;
}

async function main(): Promise<void> {
  await assertAtsV2AuthorityActive();
  const before = await readAtsCoordinationGate();
  const beforeValidation = validateAtsCoordinationGate(before);
  if (!beforeValidation.valid) throw new Error(beforeValidation.reason);
  if (!before) throw new Error('ATS acquisition coordination gate is missing.');
  if (!DISABLE && !before.cutoverReadyAt) {
    throw new Error('Distributed ATS activation requires a recorded clean-cutover boundary.');
  }

  const localSlotReserve = integerArgument('--local-reserve', ATS_PI_LOCAL_SLOT_RESERVE);
  const globalSlotLimit = integerArgument('--global-slots', Math.max(5, before.globalSlotLimit || 4));
  if (localSlotReserve < 0) {
    throw new Error('--local-reserve cannot be negative.');
  }
  if (globalSlotLimit < localSlotReserve || globalSlotLimit < 1 || globalSlotLimit > 8) {
    throw new Error('--global-slots must be between the local reserve and 8, and at least 1.');
  }

  const now = new Date();
  const activeSlots = await prisma.atsAcquisitionWorkerSlot.count({
    where: { leaseToken: { not: null }, leaseExpiresAt: { gt: now } },
  });
  const proposed = {
    distributedWriterVersion: DISABLE ? before.distributedWriterVersion : ATS_DISTRIBUTED_WORKER_VERSION,
    remoteWorkersEnabled: !DISABLE,
    localSlotReserve,
    globalSlotLimit: DISABLE ? Math.max(1, localSlotReserve) : globalSlotLimit,
  };
  if (!APPLY) {
    console.log(JSON.stringify({ apply: false, disable: DISABLE, before, proposed, activeSlots }));
    return;
  }
  if (!ATS_DISTRIBUTED_WORKERS_ENABLED && !DISABLE) {
    throw new Error('Activation requires ATS_DISTRIBUTED_WORKERS_ENABLED=true in the compatible runtime environment.');
  }
  if (DISABLE && activeSlots > 0) {
    throw new Error(`Cannot disable distributed ATS work while ${activeSlots} capacity lease(s) are active.`);
  }

  await prisma.$transaction(async (transaction) => {
    for (let slotNumber = 1; slotNumber <= 8; slotNumber++) {
      await transaction.atsAcquisitionWorkerSlot.upsert({
        where: { slotNumber },
        update: {},
        create: { slotNumber },
      });
    }
    await transaction.atsAcquisitionRuntimeGate.update({
      where: { id: 'global' },
      data: {
        distributedAuthorityActivatedAt: DISABLE
          ? before.distributedAuthorityActivatedAt
          : before.distributedAuthorityActivatedAt || now,
        distributedWriterVersion: proposed.distributedWriterVersion,
        remoteWorkersEnabled: proposed.remoteWorkersEnabled,
        localSlotReserve: proposed.localSlotReserve,
        globalSlotLimit: proposed.globalSlotLimit,
      },
    });
  });

  const after = await readAtsCoordinationGate();
  const validation = validateAtsCoordinationGate(after, {
    requireDistributed: !DISABLE,
    requireRemote: !DISABLE,
  });
  if (!validation.valid) throw new Error(validation.reason);
  console.log(JSON.stringify({
    apply: true,
    disable: DISABLE,
    before,
    after,
    activeSlots,
    requiresPiAcquisitionRestart: !DISABLE && localSlotReserve > 0,
    remoteStartCondition: !DISABLE
      ? (localSlotReserve > 0
        ? `${localSlotReserve} healthy pi-acquisition slot leases`
        : 'none: the Pi reserves no ATS acquisition capacity')
      : null,
  }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
