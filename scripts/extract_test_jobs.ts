import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const exportPath = path.join(process.cwd(), '.agents', 'export.json');
  let sharedContext = {};
  if (fs.existsSync(exportPath)) {
    const exportData = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    sharedContext = {
      resume: exportData.resume,
      contextRules: exportData.contextRules,
      wildcardProfile: exportData.wildcardProfile,
      explicitWildcardFeedback: exportData.explicitWildcardFeedback
    };
  }

  const jobs = await prisma.job.findMany({
    where: { status: 'inbox', aimFitScore: { not: null } },
    take: 10,
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      aimFitScore: true,
      reqFitScore: true
    }
  });

  const testDir = path.join(process.cwd(), '.agents', 'test_chunks');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });

  fs.writeFileSync(path.join(testDir, 'shared_context.json'), JSON.stringify(sharedContext, null, 2));

  // Write baseline scores file so we can compare easily later
  const baselines = jobs.map(j => ({
    id: j.id,
    title: j.title,
    company: j.company,
    proAimFitScore: j.aimFitScore,
    proReqFitScore: j.reqFitScore
  }));
  fs.writeFileSync(path.join(testDir, 'pro_baselines.json'), JSON.stringify(baselines, null, 2));

  // Create 2 chunks of 5 jobs each
  const chunk0 = jobs.slice(0, 5);
  const chunk1 = jobs.slice(5, 10);

  fs.writeFileSync(path.join(testDir, 'chunk_0.json'), JSON.stringify({ batchId: 'test_batch', type: 'standard', jobs: chunk0 }, null, 2));
  fs.writeFileSync(path.join(testDir, 'chunk_1.json'), JSON.stringify({ batchId: 'test_batch', type: 'standard', jobs: chunk1 }, null, 2));

  console.log(`Successfully extracted ${jobs.length} jobs into .agents/test_chunks/`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
