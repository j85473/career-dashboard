import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request) {
  try {
    const data = await request.json();
    
    let records = null;
    if (Array.isArray(data)) {
      records = data;
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.jobs)) records = data.jobs;
      else if (Array.isArray(data.results)) records = data.results;
      else if (Array.isArray(data.tailored_resumes)) records = data.tailored_resumes;
      else if (data.job_id || data.company_name || data.company) records = [data];
    }

    if (!records) {
      return NextResponse.json({ error: 'Expected an array of tailored records or an object with a jobs array' }, { status: 400 });
    }

    let importedCount = 0;

    for (const record of records) {
      let parsedCompanyName = '';
      if (record.submission_filename) {
        // e.g. "Rubrik_Resume.docx" -> "Rubrik", "Yoodli_2_Resume.docx" -> "Yoodli"
        parsedCompanyName = record.submission_filename.split('_')[0];
      }

      const jobId = record.job_id || record.id || (record.job_metadata && record.job_metadata.job_id);
      const jobName = parsedCompanyName || record.company_name || record.company || record.job_name || (record.job_metadata && (record.job_metadata.company || record.job_metadata.company_name));

      if (!jobId && !jobName) continue;

      // Find the job by ID or name
      let job = null;
      let searchName = jobName;

      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId || '');

      if (jobId && isUUID) {
        try {
          job = await prisma.job.findUnique({ where: { id: jobId } });
        } catch (e) {
          console.error("Invalid UUID query skipped", e);
        }
      } else if (jobId && !isUUID && !searchName) {
        searchName = jobId; // Use the invalid ID (e.g. "molex") as a fallback company name search
      }
      
      if (!job && searchName) {
        // Fallback to searching by company name if it's staged for tailoring
        const jobs = await prisma.job.findMany({
          where: { 
            company: { contains: searchName, mode: 'insensitive' },
            tailoringStaged: true
          }
        });
        if (jobs.length > 0) {
          job = jobs[0];
        } else {
          // Find any if not staged
          const anyJobs = await prisma.job.findMany({
            where: { company: { contains: searchName, mode: 'insensitive' } },
            orderBy: { createdAt: 'desc' }
          });
          if (anyJobs.length > 0) {
            job = anyJobs[0];
          }
        }
      }

      if (job) {
        // We will store the entire record as the context packet
        const contextPacket = JSON.stringify(record, null, 2);
        
        // If there's a submittedResume field in the JSON in the future, we can extract it.
        // For now, we will just save the contextPacket.
        const submittedResume = record.submitted_resume || record.submittedResume || null;

        await prisma.job.update({
          where: { id: job.id },
          data: {
            contextPacket,
            ...(submittedResume ? { submittedResume } : {}),
            status: 'applied', // Move to applied queue automatically when tailoring imported
            luckyStatus: 'none',
            contextBatched: false,
            tailoringStaged: false,
          }
        });

        // Trigger cooldown logic for other jobs from the same company
        if (job.company) {
          const threeWeeksFromNow = new Date();
          threeWeeksFromNow.setDate(threeWeeksFromNow.getDate() + 21);
          
          await prisma.job.updateMany({
            where: { company: job.company, status: 'inbox', id: { not: job.id } },
            data: { status: 'cooldown', cooldownUntil: threeWeeksFromNow }
          });
          
          await prisma.job.updateMany({
            where: { company: job.company, luckyStatus: 'inbox', id: { not: job.id } },
            data: { luckyStatus: 'cooldown', cooldownUntil: threeWeeksFromNow }
          });
        }

        importedCount++;
      }
    }

    if (importedCount === 0) {
      return NextResponse.json({ error: 'No matching jobs found in the uploaded JSON. Check that the job_id or company_name fields exist and match.' }, { status: 400 });
    }
    return NextResponse.json({ message: `Successfully imported and applied ${importedCount} tailored jobs.`, count: importedCount });
  } catch (error: unknown) {
    console.error('Failed to import tailoring:', error);
    return NextResponse.json({
      error: 'Failed to import tailoring data',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
