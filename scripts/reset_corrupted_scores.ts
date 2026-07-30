import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const filePath = path.join(process.cwd(), '.agents', 'eval_chunks', 'final_results.json');
  if (!fs.existsSync(filePath)) {
    console.error('No final_results.json found');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const standardScores = data.standardScores || [];
  
  if (standardScores.length === 0) {
    console.log('No scores found in final_results.json');
    return;
  }

  const jobIds = standardScores.map((jobData: any) => jobData.id || jobData.jobId).filter(Boolean);
  
  console.log(`Found ${jobIds.length} corrupted job IDs. Resetting their scores...`);
  
  // Reset Job records
  const updateResult = await prisma.job.updateMany({
    where: {
      id: { in: jobIds }
    },
    data: {
      aimFitScore: null,
      reqFitScore: null,
      status: 'pending',
      scoringStatus: 'pending'
    }
  });

  // Delete bad JobScoreEvent records
  // The direct_import script used promptVersion: 'v4' and model: 'agentic_bypass'
  const deleteResult = await prisma.jobScoreEvent.deleteMany({
    where: {
      jobId: { in: jobIds },
      model: 'agentic_bypass'
    }
  });

  console.log(`Success: Reset ${updateResult.count} jobs back to 'pending'.`);
  console.log(`Success: Deleted ${deleteResult.count} corrupted JobScoreEvent records.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
