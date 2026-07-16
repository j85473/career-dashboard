import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  cleanHtmlText,
  generateFingerprint,
  isLikelyDuplicatePosting,
  normalizeUrl,
} from '@/lib/jobIngestion';
import { passesPreFilter } from '@/lib/jobFiltering';

export async function POST() {
  try {
    const apiToken = process.env.APIFY_API_TOKEN;
    
    if (!apiToken) {
      return NextResponse.json({ error: 'APIFY_API_TOKEN is not set in environment variables.' }, { status: 500 });
    }

    // Fetch the dataset from the last run of the cheap_scraper~linkedin-job-scraper actor
    const actorId = 'cheap_scraper~linkedin-job-scraper';
    const apiUrl = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items`;
    

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
      if (!item.jobTitle || !item.companyName || !item.jobUrl) {
        continue;
      }

      // Check if job already exists to avoid duplicates
      const location = item.location || 'Remote';
      const description = cleanHtmlText(item.jobDescription || '');
      const canonicalUrl = normalizeUrl(item.jobUrl);
      const source = 'LinkedIn (Apify)';
      const sourceId = String(item.id || canonicalUrl);
      const fingerprint = generateFingerprint(item.jobTitle, item.companyName);

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
        title: item.jobTitle,
        company: item.companyName,
        location,
        description,
        url: item.jobUrl,
        canonicalUrl,
        source,
        sourceId,
      }));

      if (!existingJob) {
        const filter = passesPreFilter({
          title: item.jobTitle,
          company: item.companyName,
          description,
          location,
          url: canonicalUrl,
        });
        await prisma.job.create({
          data: {
            title: item.jobTitle,
            company: item.companyName,
            location,
            description,
            url: item.jobUrl,
            canonicalUrl,
            source,
            sourceId,
            status: filter.passes ? 'pending_af' : 'archived',
            passReason: filter.passes ? null : filter.reason,
            scoringStatus: filter.passes ? (description.length >= 400 ? 'queued' : 'needs_jd') : 'skipped',
            luckyStatus: filter.passes ? 'pending' : 'none',
            fingerprint,
            postedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
            observations: {
              create: { source, sourceId, url: item.jobUrl },
            },
          }
        });
        insertedCount++;
      } else {
        await prisma.jobSourceObservation.upsert({
          where: { source_sourceId: { source, sourceId } },
          update: { url: item.jobUrl },
          create: { jobId: existingJob.id, source, sourceId, url: item.jobUrl },
        });
      }
    }

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
