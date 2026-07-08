import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function run() {
  const backupPath = path.join(process.cwd(), 'scores_backup.json');
  if (!fs.existsSync(backupPath)) {
    console.error('No backup found.');
    return;
  }

  const oldJobs = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const newJobs = await prisma.job.findMany({
    where: { id: { in: oldJobs.map((j: any) => j.id) } },
    select: { id: true, aimFitScore: true, reqFitScore: true, luckyAimFitScore: true, luckyFitScore: true }
  });

  const newJobsMap = new Map(newJobs.map(j => [j.id, j]));

  let md = `# Score Comparison: Core vs Channel Sales Resume\n\n`;
  md += `This artifact shows the before-and-after scores for jobs in your inbox, demonstrating how the new single 'Channel Sales' resume performs compared to the old multiple-flavor setup.\n\n`;

  md += `## Inbox Jobs\n\n`;
  md += `| Company | Title | Aim (Old -> New) | Exp (Old -> New) |\n`;
  md += `|---|---|---|---|\n`;

  let luckyMd = `\n## Feeling Lucky Jobs\n\n`;
  luckyMd += `| Company | Title | Aim (Old -> New) | Exp (Old -> New) |\n`;
  luckyMd += `|---|---|---|---|\n`;

  for (const oldJob of oldJobs) {
    const newJob = newJobsMap.get(oldJob.id);
    if (!newJob) continue;

    if (oldJob.status === 'inbox') {
      const aimChange = `${oldJob.aimFitScore ?? 'null'} -> **${newJob.aimFitScore ?? 'null'}**`;
      const expChange = `${oldJob.reqFitScore ?? 'null'} -> **${newJob.reqFitScore ?? 'null'}**`;
      md += `| ${oldJob.company} | ${oldJob.title} | ${aimChange} | ${expChange} |\n`;
    } else if (oldJob.luckyStatus === 'inbox') {
      const aimChange = `${oldJob.luckyAimFitScore ?? 'null'} -> **${newJob.luckyAimFitScore ?? 'null'}**`;
      const expChange = `${oldJob.luckyFitScore ?? 'null'} -> **${newJob.luckyFitScore ?? 'null'}**`;
      luckyMd += `| ${oldJob.company} | ${oldJob.title} | ${aimChange} | ${expChange} |\n`;
    }
  }

  md += luckyMd;

  fs.writeFileSync('/Users/JosephLamb/.gemini/antigravity/brain/ac38409b-f8b5-4078-8af4-df7fc258a1a9/score_comparison.md', md);
  console.log('Artifact created: score_comparison.md');

  await prisma.$disconnect();
}

run();
