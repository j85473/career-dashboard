import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const data = JSON.parse(fs.readFileSync('/Users/JosephLamb/Desktop/consolidated_applied_jobs.json', 'utf8'));
  const records = Array.isArray(data) ? data : (data.jobs || data.results || []);
  
  let restoredCount = 0;
  let notFoundCount = 0;

  for (const record of records) {
    const meta = record.job_metadata || {};
    const company = meta.company || record.company_name;
    
    if (!company) {
      console.log('Skipping record without company name');
      continue;
    }

    // Try to find a job by this company in the database
    const jobs = await prisma.job.findMany({
      where: { company: { contains: company, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' }
    });

    if (jobs.length > 0) {
      // Pick the first match
      const job = jobs[0];
      
      const contextPacket = JSON.stringify(record, null, 2);
      
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'applied',
          contextBatched: false,
          luckyStatus: 'none',
          tailoringStaged: false,
          contextPacket
        }
      });
      restoredCount++;
      console.log(`Restored job for company: ${company}`);
    } else {
      notFoundCount++;
      console.log(`Could not find a duplicate for company: ${company}`);
    }
  }

  console.log(`\nRestore complete! Successfully restored ${restoredCount} jobs to 'applied'.`);
  console.log(`${notFoundCount} jobs could not be found.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
