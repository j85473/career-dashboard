import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const fileContent = fs.readFileSync('/tmp/resume_list.txt', 'utf8');
  const filenames = fileContent.split('\n').filter(Boolean);
  
  let restoredCount = 0;
  let notFoundCount = 0;

  for (const filename of filenames) {
    // Extract company name: "Abbott_Clinical Specialist..." -> "Abbott", "Acquia_Resume.docx" -> "Acquia"
    let company = filename.split('_')[0];
    company = company.replace('.docx', '').trim();
    
    if (!company) continue;

    // Fix some known edge cases from filenames
    if (company === 'Blank' || company === 'American' || company === 'AssetWatch') {
      // Just do our best with the first word
    }

    const jobs = await prisma.job.findMany({
      where: { company: { contains: company, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' }
    });

    if (jobs.length > 0) {
      const job = jobs[0];
      
      // We don't have the contextPacket json, but we know it's applied
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'applied',
          contextBatched: false,
          luckyStatus: 'none',
          tailoringStaged: false
        }
      });
      restoredCount++;
    } else {
      notFoundCount++;
    }
  }

  console.log(`\nFilename Restore complete! Successfully restored ${restoredCount} jobs to 'applied'.`);
  console.log(`${notFoundCount} jobs could not be found based on filename.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
