import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { identifyAts } from '@/lib/atsUtils';

export async function GET() {
  try {
    const jobs = await prisma.job.findMany({
      where: { tailoringStaged: true }
    });

    const now = new Date();
    const batchId = `batch_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

    const exportData = {
      batch_id: batchId,
      jobs: jobs.map(j => ({
        job_id: j.id,
        company_name: j.company,
        job_title: j.title,
        job_url: j.url || j.canonicalUrl || '',
        ats_system: j.manualAts || identifyAts({ url: j.url || undefined, source: j.source || undefined }),
        job_description_text: j.description || '',
        job_specific_rules: j.tailoringAdvice ? [j.tailoringAdvice] : []
      }))
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${batchId}.json"`
      }
    });
  } catch (error) {
    console.error("Export failed", error);
    return NextResponse.json({ error: "Failed to export data" }, { status: 500 });
  }
}
