import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const data = JSON.parse(fs.readFileSync('results.json', 'utf8'));
  console.log(`Updating ${data.length} jobs...`);

  for (const item of data) {
    if (!item.jobId) continue;
    try {
      await prisma.job.update({
        where: { id: item.jobId },
        data: {
          aimFitScore: item.score,
          travelScore: item.travelScore,
          fitRationale: item.rationale,
          scoringStatus: 'scored',
        },
      });
      console.log(`Successfully updated job ${item.jobId}`);
    } catch (e) {
      console.error(`Failed to update job ${item.jobId}:`, e);
    }
  }

  console.log('Done!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
