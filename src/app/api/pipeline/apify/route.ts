import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  cleanHtmlText,
  generateFingerprint,
  isLikelyDuplicatePosting,
  normalizeUrl,
} from '@/lib/jobIngestion';
import { passesPreFilter } from '@/lib/jobFiltering';

export async function POST(request: Request) {
  const startTime = Date.now();
  try {
    let datasetId = 'last';
    try {
      const body = await request.json();
      if (body?.datasetId) {
        datasetId = body.datasetId;
      }
    } catch (e) {
      // ignore empty body
    }
    
    const apiToken = process.env.APIFY_API_TOKEN;
    
    if (!apiToken) {
      return NextResponse.json({ error: 'APIFY_API_TOKEN is not set in environment variables.' }, { status: 500 });
    }

    // Fetch the dataset from the specified run of the cheap_scraper~linkedin-job-scraper actor
    const actorId = 'cheap_scraper~linkedin-job-scraper';
    const apiUrl = datasetId === 'last' 
      ? `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items`
      : `https://api.apify.com/v2/datasets/${datasetId}/items`;
    
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(20000),
    });
    
    if (!response.ok) {
      console.error(`Apify API error: HTTP ${response.status}`);
      return NextResponse.json({ error: 'Failed to fetch dataset from Apify' }, { status: response.status });
    }

    const items = await response.json();


    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: true, message: 'No jobs found in the latest run.', jobsFetched: 0, newJobsInserted: 0 });
    }

    let insertedCount = 0;

    for (const item of items) {
      // Validate essential fields
      const title = item.jobTitle || item.title || item.job_title;
      const company = item.companyName || item.company_name || item.company;
      const url = item.jobUrl || item.url || item.job_url;

      if (!title || !company || !url) {
        console.warn('Apify job missing essential fields, skipping:', JSON.stringify(item).substring(0, 200));
        continue;
      }

      // Check if job already exists to avoid duplicates
      const location = item.location || item.jobLocation || 'Remote';
      const description = cleanHtmlText(item.jobDescription || item.description || '');
      
      let atsUrl: string | null = null;
      const atsRegex = /https:\/\/(?:jobs\.lever\.co|boards\.greenhouse\.io|jobs\.ashbyhq\.com|[\w-]+\.wd[\w-]*\.myworkdayjobs\.com|[\w-]+\.workable\.com|jobs\.smartrecruiters\.com)\/[^\s<)"]+/i;
      const atsMatch = description.match(atsRegex);
      if (atsMatch) {
        atsUrl = atsMatch[0];
      }
      
      const canonicalUrl = normalizeUrl(atsUrl || url);
      const source = atsUrl ? 'LinkedIn (Apify) -> ATS' : 'LinkedIn (Apify)';
      const sourceId = String(item.id || canonicalUrl);
      const fingerprint = generateFingerprint(title, company);

      const existingObservation = await prisma.jobSourceObservation.findUnique({
        where: { source_sourceId: { source, sourceId } },
      });
      if (existingObservation) continue;
      
      const candidates = await prisma.job.findMany({
        where: { 
          createdAt: { gte: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
          OR: [
            { canonicalUrl },
            { fingerprint }
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const existingJob = candidates.find((candidate) => isLikelyDuplicatePosting(candidate, {
        title,
        company,
        location,
        description,
        url,
        canonicalUrl,
        source,
        sourceId,
      }));

      if (!existingJob) {
        const filter = passesPreFilter({
          title,
          company,
          description,
          location,
          url: canonicalUrl,
        });
        await prisma.job.create({
          data: {
            title,
            company,
            location,
            description,
            url: atsUrl || url,
            canonicalUrl,
            source,
            sourceId,
            status: filter.passes ? 'pending_af' : 'archived',
            passReason: filter.passes ? null : filter.reason,
            scoringStatus: filter.passes ? (description.length >= 400 ? 'queued' : 'needs_jd') : 'skipped',
            luckyStatus: 'none',
            fingerprint,
            postedAt: item.publishedAt || item.date ? new Date(item.publishedAt || item.date) : new Date(),
            observations: {
              create: { source, sourceId, url },
            },
          }
        });
        insertedCount++;
      } else {
        await prisma.jobSourceObservation.upsert({
          where: { source_sourceId: { source, sourceId } },
          update: { url: atsUrl || url },
          create: { jobId: existingJob.id, source, sourceId, url: atsUrl || url },
        });
      }
    }

    await prisma.ingestionSourceRun.create({
      data: {
        source: 'LinkedIn (Apify)',
        status: 'success',
        seenCount: items.length,
        insertedCount: insertedCount,
        duplicateCount: items.length - insertedCount,
        filteredCount: 0,
        errorCount: 0,
        finishedAt: new Date(),
        durationMs: Date.now() - startTime,
      }
    });

    return NextResponse.json({ 
      success: true,
      message: 'Apify sync completed successfully', 
      jobsFetched: items.length, 
      newJobsInserted: insertedCount 
    });

  } catch (error: unknown) {
    console.error('Error syncing with Apify:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
