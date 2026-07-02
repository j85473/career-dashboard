import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  
  const job = await prisma.job.findUnique({
    where: { id }
  });

  if (!job) {
    return new NextResponse('Job not found', { status: 404 });
  }

  // If we already resolved a canonical URL that doesn't look like an aggregator, use it
  if (job.canonicalUrl && !job.canonicalUrl.includes('adzuna.com') && !job.canonicalUrl.includes('indeed.com') && !job.canonicalUrl.includes('jsearch')) {
    return NextResponse.redirect(job.canonicalUrl);
  }

  // Attempt to resolve the canonical URL using SerpApi Google Search
  const serpApiKey = process.env.SERPAPI_KEY;
  let resolvedUrl = job.url || '';

  if (serpApiKey) {
    try {
      const query = `${job.company} ${job.title} careers`;
      const serpParams = new URLSearchParams({
        engine: "google",
        q: query,
        api_key: serpApiKey,
      });

      const serpRes = await fetch(`https://serpapi.com/search.json?${serpParams.toString()}`);
      if (serpRes.ok) {
        const data = await serpRes.json();
        const topResult = data.organic_results?.[0]?.link;
        
        // Ensure the top result is a reasonable match (e.g. not another job board aggregator if possible)
        // Usually, the company's own domain ranks #1 for exact title + company name searches.
        if (topResult && !topResult.includes('adzuna.com') && !topResult.includes('indeed.com') && !topResult.includes('salary.com')) {
          resolvedUrl = topResult;
          
          // Save this resolution for future clicks
          await prisma.job.update({
            where: { id },
            data: { canonicalUrl: resolvedUrl }
          });
        }
      }
    } catch (e) {
      console.error(`Failed to resolve canonical URL for job ${id}:`, e);
    }
  }

  if (!resolvedUrl) {
    if (job.source === 'Indeed' && job.sourceId) {
      resolvedUrl = `https://www.indeed.com/viewjob?jk=${job.sourceId}`;
    } else {
      resolvedUrl = `https://www.google.com/search?q=${encodeURIComponent(`${job.company} ${job.title} job careers`)}`;
    }
  }

  return NextResponse.redirect(resolvedUrl);
}
