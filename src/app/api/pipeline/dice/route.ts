import { NextResponse } from 'next/server';
import { ApifyClient } from 'apify-client';
import { ingestExternalJob } from '@/lib/jobIngestion';
import { prisma } from '@/lib/prisma';

export async function POST() {
  const startTime = Date.now();
  try {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) {
      return NextResponse.json({ error: 'APIFY_API_TOKEN is not set in environment variables.' }, { status: 500 });
    }

    const client = new ApifyClient({ token });

    const input = {
      "employment_type": [
          "FULLTIME"
      ],
      "job_entries": 1000,
      "keyword": "sales",
      "location": "55405",
      "posted_date": "ANY",
      "radius": 50,
      "unit": "mi"
    };
    
    // Run the Actor and wait for it to finish
    const run = await client.actor("worldunboxer/dice-jobs-scraper").call(input);
    
    // Fetch the results from the dataset
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: true, message: 'No jobs found in the latest Dice run.', jobsFetched: 0, newJobsInserted: 0 });
    }

    let inserted = 0;
    let duplicates = 0;
    let filtered = 0;
    let errors = 0;

    for (const item of items) {
      try {
        const jobItem = item as Record<string, unknown>;
        
        const title = (jobItem.title as string) || "Unknown Title";
        const company = (jobItem.company as string) || "Unknown Company";
        const location = (jobItem.location as string) || "Unknown Location";
        const description = (jobItem.summary as string) || "";
        const url = (jobItem.details_page_url as string) || "";
        const sourceId = (jobItem.job_id as string) || (jobItem.guid as string) || url;
        
        let postedAt: Date | undefined = undefined;
        if (jobItem.posted_date) {
          const parsed = new Date(jobItem.posted_date as string);
          if (!Number.isNaN(parsed.getTime())) {
            postedAt = parsed;
          }
        }

        const outcome = await ingestExternalJob({
          title,
          company,
          description,
          location,
          url,
          source: 'Dice',
          sourceId,
          postedAt
        }, 'inbox');

        if (outcome === 'inserted') inserted++;
        else if (outcome === 'duplicate') duplicates++;
        else if (outcome === 'filtered') filtered++;
      } catch (error) {
        console.error(`Error ingesting Dice job:`, error);
        errors++;
      }
    }

    await prisma.ingestionSourceRun.create({
      data: {
        source: 'Dice (Apify)',
        status: 'success',
        seenCount: items.length,
        insertedCount: inserted,
        duplicateCount: duplicates,
        filteredCount: filtered,
        errorCount: errors,
        finishedAt: new Date(),
        durationMs: Date.now() - startTime,
      }
    });

    return NextResponse.json({ 
      success: true,
      message: 'Dice Apify sync completed successfully', 
      jobsFetched: items.length, 
      newJobsInserted: inserted 
    });

  } catch (error: unknown) {
    console.error('Error syncing with Dice Apify:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
