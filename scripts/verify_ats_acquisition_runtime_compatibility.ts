import {
  ATS_ACQUISITION_WRITER_VERSION,
  assertAtsAcquisitionWriterCompatibility,
} from '../src/lib/atsAcquisitionCompatibility';
import { prisma } from '../src/lib/prisma';

async function main() {
  const gate = await assertAtsAcquisitionWriterCompatibility();
  console.log(JSON.stringify({
    compatible: true,
    writerVersion: ATS_ACQUISITION_WRITER_VERSION,
    minimumWriterVersion: gate.minimumWriterVersion,
    compatibilityWriterVersion: gate.compatibilityWriterVersion,
    v2AuthorityActivatedAt: gate.v2AuthorityActivatedAt?.toISOString() || null,
    activatedLedgerVersion: gate.activatedLedgerVersion,
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
