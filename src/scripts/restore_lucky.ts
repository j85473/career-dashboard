import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function restore() {
  console.log("Restoring lucky fields from backup...");
  const raw = fs.readFileSync('scores_backup.json', 'utf8');
  const backup = JSON.parse(raw);

  let updated = 0;
  let skipped = 0;

  for (const b of backup) {
    if (b.luckyStatus !== undefined || b.luckyAimFitScore !== undefined || b.luckyFitScore !== undefined) {
      try {
        await prisma.job.update({
          where: { id: b.id },
          data: {
            luckyStatus: b.luckyStatus || 'none',
            luckyAimFitScore: b.luckyAimFitScore,
            luckyFitScore: b.luckyFitScore
          }
        });
        updated++;
        if (updated % 100 === 0) console.log(`Restored ${updated} jobs...`);
      } catch (e: any) {
        if (e.code === 'P2025') {
          skipped++;
        } else {
          console.error(`Error updating ${b.id}:`, e);
        }
      }
    }
  }

  console.log(`Finished. Restored ${updated} jobs. Skipped ${skipped} (not found).`);
}

restore()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
