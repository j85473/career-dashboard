import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: 'applied',
    },
    take: 50,
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      url: true,
      canonicalUrl: true,
      fitScore: true,
      fitRationale: true,
      tailoringAdvice: true,
      submittedResume: true,
      reqFitRationale: true,
      aimFitScore: true,
    }
  });

  const desktopPath = path.join(os.homedir(), 'Desktop');
  const outputPath = path.join(desktopPath, 'applied_jobs_for_tailoring.json');

  fs.writeFileSync(outputPath, JSON.stringify(jobs, null, 2), 'utf-8');
  console.log(`Successfully exported ${jobs.length} jobs to ${outputPath}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
