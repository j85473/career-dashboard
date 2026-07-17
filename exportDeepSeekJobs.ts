import { prisma } from "./src/lib/prisma";
import fs from "fs";

async function main() {
  const deepseekJobs = await prisma.job.findMany({
    where: { scoringStatus: 'scored', status: { in: ['inbox', 'pending_af'] }, aimFitScore: null },
    select: { id: true, title: true, company: true, description: true, location: true, url: true }
  });
  
  fs.writeFileSync("deepseek_jobs.json", JSON.stringify(deepseekJobs, null, 2));
  console.log(`Exported ${deepseekJobs.length} jobs to deepseek_jobs.json`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
