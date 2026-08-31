import {
  ATS_ACQUISITION_WRITER_VERSION,
  validateAtsV2AuthorityActive,
} from '../src/lib/atsAcquisitionCompatibility';
import {
  ATS_ACQUISITION_V2_ENABLED,
  ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED,
  ATS_ACQUISITION_V2_SHADOW_ENABLED,
  ATS_ACQUISITION_V2_SLOT_COUNT,
  promoteDrainedLegacyBoardsToV2,
} from '../src/lib/atsAcquisitionDispatcherV2';
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!ATS_ACQUISITION_V2_ENABLED
    || !ATS_ACQUISITION_V2_SHADOW_ENABLED
    || !ATS_ACQUISITION_V2_SEGMENT_CONSUMER_ENABLED
    || ATS_ACQUISITION_V2_SLOT_COUNT < 2) {
    throw new Error(
      'ATS v2 activation requires dispatcher, shadow, and segment publication enabled with at least two v2 slots.',
    );
  }

  const before = await prisma.atsAcquisitionRuntimeGate.findUnique({
    where: { id: 'global' },
    select: {
      minimumWriterVersion: true,
      compatibilityWriterVersion: true,
      v2AuthorityActivatedAt: true,
      activatedLedgerVersion: true,
    },
  });
  if (!before) throw new Error('ATS acquisition runtime gate is missing.');

  const eligibleBefore = await prisma.atsCompany.count({
    where: {
      acquisitionEngine: 'legacy',
      status: { in: ['active', 'parked', 'blacklisted'] },
      checkAttempts: { none: { outcome: 'running' } },
      ingestionBatches: {
        none: { status: { in: ['fetching', 'partial', 'synchronized', 'queued', 'processing'] } },
      },
    },
  });

  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      writerVersion: ATS_ACQUISITION_WRITER_VERSION,
      gate: before,
      eligibleLegacyBoards: eligibleBefore,
    }));
    return;
  }

  const activatedAt = before.v2AuthorityActivatedAt || new Date();
  await prisma.atsAcquisitionRuntimeGate.update({
    where: { id: 'global' },
    data: {
      minimumWriterVersion: ATS_ACQUISITION_WRITER_VERSION,
      compatibilityWriterVersion: ATS_ACQUISITION_WRITER_VERSION,
      v2AuthorityActivatedAt: activatedAt,
      activatedLedgerVersion: 2,
      updatedAt: new Date(),
    },
  });

  const promoted = await promoteDrainedLegacyBoardsToV2();
  const gate = await prisma.atsAcquisitionRuntimeGate.findUniqueOrThrow({
    where: { id: 'global' },
    select: {
      minimumWriterVersion: true,
      compatibilityWriterVersion: true,
      v2AuthorityActivatedAt: true,
      activatedLedgerVersion: true,
    },
  });
  const authority = validateAtsV2AuthorityActive(gate);
  if (!authority.valid) throw new Error(authority.reason);

  const [legacyBoards, v2Boards, unsafeV2Boards] = await Promise.all([
    prisma.atsCompany.count({ where: { acquisitionEngine: 'legacy' } }),
    prisma.atsCompany.count({ where: { acquisitionEngine: 'v2' } }),
    prisma.atsCompany.count({
      where: {
        acquisitionEngine: 'v2',
        OR: [
          { checkAttempts: { some: { outcome: 'running' } } },
          {
            ingestionBatches: {
              some: {
                writerMode: 'legacy',
                status: { in: ['fetching', 'partial', 'synchronized', 'queued', 'processing'] },
              },
            },
          },
        ],
      },
    }),
  ]);
  if (unsafeV2Boards !== 0) {
    throw new Error(`ATS v2 activation found ${unsafeV2Boards} board(s) still carrying live legacy work.`);
  }

  console.log(JSON.stringify({
    apply: true,
    writerVersion: ATS_ACQUISITION_WRITER_VERSION,
    gate: {
      ...gate,
      v2AuthorityActivatedAt: gate.v2AuthorityActivatedAt?.toISOString() || null,
    },
    eligibleLegacyBoards: eligibleBefore,
    promotedBoards: promoted.count,
    legacyBoards,
    v2Boards,
    unsafeV2Boards,
  }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
