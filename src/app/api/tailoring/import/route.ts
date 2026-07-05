import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request) {
  try {
    const data = await request.json();
    
    const records = Array.isArray(data) ? data : (data.jobs && Array.isArray(data.jobs) ? data.jobs : null);

    if (!records) {
      return NextResponse.json({ error: 'Expected an array of tailored records or an object with a jobs array' }, { status: 400 });
    }

    let importedCount = 0;

    for (const record of records) {
      const jobId = record.job_id || (record.job_metadata && record.job_metadata.job_id);
      const jobName = record.job_name || (record.job_metadata && (record.job_metadata.company || record.job_metadata.company_name));

      if (!jobId && !jobName) continue;

      // Find the job by ID or name
      let job = null;
      if (jobId) {
        job = await prisma.job.findUnique({ where: { id: jobId } });
      }
      
      if (!job && jobName) {
        // Fallback to searching by company name if it's staged for tailoring
        const jobs = await prisma.job.findMany({
          where: { 
            company: { contains: jobName, mode: 'insensitive' },
            tailoringStaged: true
          }
        });
        if (jobs.length > 0) {
          job = jobs[0];
        } else {
          // Find any if not staged
          const anyJobs = await prisma.job.findMany({
            where: { company: { contains: jobName, mode: 'insensitive' } },
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
            tailoringStaged: false,
          }
        });
        importedCount++;
      }
    }

    return NextResponse.json({ message: 'Tailored records imported successfully', count: importedCount });
  } catch (error: any) {
    console.error('Failed to import tailoring:', error);
    return NextResponse.json({ error: 'Failed to import tailoring data', details: error.message }, { status: 500 });
  }
}
