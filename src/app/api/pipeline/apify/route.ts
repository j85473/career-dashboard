import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const apiToken = process.env.APIFY_API_TOKEN;
    
    if (!apiToken) {
      return NextResponse.json({ error: 'APIFY_API_TOKEN is not set in environment variables.' }, { status: 500 });
    }

    // Fetch the dataset from the last run of the cheap_scraper~linkedin-job-scraper actor
    const actorId = 'cheap_scraper~linkedin-job-scraper';
    const apiUrl = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items?token=${apiToken}`;
    
    console.log('Fetching Apify dataset from:', apiUrl);
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Apify API Error:', errorText);
      return NextResponse.json({ error: 'Failed to fetch dataset from Apify', details: errorText }, { status: response.status });
    }

    const items = await response.json();
    console.log(`Received ${items.length} items from Apify.`);

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ message: 'No jobs found in the latest run.' });
    }

    let insertedCount = 0;

    for (const item of items) {
      // Validate essential fields
      if (!item.jobTitle || !item.companyName || !item.jobUrl) {
        continue;
      }

      // Check if job already exists to avoid duplicates
      const existingJob = await prisma.job.findFirst({
        where: { url: item.jobUrl }
      });

      if (!existingJob) {
        const job = await prisma.job.create({
          data: {
            title: item.jobTitle,
            company: item.companyName,
            location: item.location || 'Remote',
            description: item.jobDescription || '',
            url: item.jobUrl,
            source: 'LinkedIn (Apify)',
            status: 'pending_af', // Bypass JD extraction, go straight to AI Evaluator
            scoringStatus: 'scored',
            luckyStatus: 'none', 
            postedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
          }
        });
        insertedCount++;
      }
    }

    return NextResponse.json({ 
      message: 'Apify sync completed successfully', 
      jobsFetched: items.length, 
      newJobsInserted: insertedCount 
    });

  } catch (error: any) {
    console.error('Error syncing with Apify:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error.message }, { status: 500 });
  }
}
