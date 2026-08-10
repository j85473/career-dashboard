import { NextResponse } from 'next/server';
import { ApifyClient } from 'apify-client';
import {
  countExternalIngestionOutcome,
  emptyExternalIngestionCounters,
  externalIngestionContext,
  ingestExternalJob,
  persistExternalIngestionSourceRun,
} from '@/lib/jobIngestion';
import {
  recordJobPipelineEvent,
  recordProviderFailure,
  recordProviderSuccess,
  reserveProviderRequest,
} from '@/lib/ingestionControl';

const SOURCE = 'Dice (Apify)';

export async function POST(request?: Request) {
  const startedAt = new Date();
  const counters = emptyExternalIngestionCounters();
  const context = externalIngestionContext(request, 'apify-dice');

  try {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) {
      const reason = 'APIFY_API_TOKEN is not configured';
      const ingestionStatus = await persistExternalIngestionSourceRun({
        source: SOURCE,
        counters,
        context,
        startedAt,
        status: 'disabled',
        error: reason,
      });
      return NextResponse.json({ success: true, details: reason, ingestionStatus, ingestionCounters: counters });
    }

    const budget = await reserveProviderRequest({ provider: SOURCE, dailyLimit: 1 });
    if (!budget.allowed) throw new Error(`${SOURCE} request blocked by ${budget.reason}`);
    counters.requests = (counters.requests || 0) + 1;
    await recordJobPipelineEvent({
      eventType: 'provider_request',
      taskId: context.taskId,
      stage: 'provider',
      source: SOURCE,
      queryFamily: context.queryFamily,
      geoLane: context.geoLane,
      details: { requestNumber: counters.requests },
      identityParts: [context.windowEnd?.toISOString() || startedAt.toISOString(), counters.requests],
    });

    const client = new ApifyClient({ token });
    const run = await client.actor('worldunboxer/dice-jobs-scraper').call({
      employment_type: ['FULLTIME'],
      job_entries: 1000,
      keyword: 'sales',
      location: '55405',
      posted_date: 'ANY',
      radius: 50,
      unit: 'mi',
    });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    if (!Array.isArray(items)) throw new Error('Invalid response schema: Dice dataset is not an array');
    await recordProviderSuccess(SOURCE);

    for (const rawItem of items) {
      try {
        const item = rawItem as Record<string, unknown>;
        const title = String(item.title || '').trim();
        const company = String(item.company || '').trim();
        const url = String(item.details_page_url || '').trim();
        const sourceId = String(item.job_id || item.guid || url).trim();
        if (!title || !company || !url || !sourceId) {
          countExternalIngestionOutcome(counters, 'processing_error');
          continue;
        }
        const dateValue = item.posted_date;
        const parsedDate = dateValue ? new Date(String(dateValue)) : undefined;
        const outcome = await ingestExternalJob({
          title,
          company,
          description: String(item.summary || ''),
          location: String(item.location || '').trim() || 'Unknown Location',
          url,
          source: 'Dice',
          sourceId,
          postedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : undefined,
          searchQuery: 'sales',
          ingestionMode: context.ingestionMode,
          taskId: context.taskId,
          queryFamily: context.queryFamily,
          geoLane: context.geoLane,
          windowStart: context.windowStart,
          windowEnd: context.windowEnd,
        });
        countExternalIngestionOutcome(counters, outcome);
      } catch (error) {
        console.error('Error ingesting Dice job:', error);
        countExternalIngestionOutcome(counters, 'processing_error');
      }
    }

    const ingestionStatus = await persistExternalIngestionSourceRun({
      source: SOURCE,
      counters,
      context,
      startedAt,
    });
    return NextResponse.json({
      success: true,
      message: 'Dice Apify sync completed successfully',
      jobsFetched: items.length,
      newJobsInserted: counters.inserted,
      ingestionStatus,
      ingestionCounters: counters,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    counters.providerErrors++;
    const providerIncidentId = await recordProviderFailure({
      provider: SOURCE,
      error,
      taskKey: context.taskId,
      queryFamily: context.queryFamily,
      geoLane: context.geoLane,
    }).catch(() => null);
    const ingestionStatus = await persistExternalIngestionSourceRun({
      source: SOURCE,
      counters,
      context,
      startedAt,
      error: message,
      providerIncidentId,
    }).catch(() => 'failed' as const);
    return NextResponse.json({
      error: 'Dice Apify sync failed',
      details: message,
      ingestionStatus,
      ingestionCounters: counters,
    }, { status: 502 });
  }
}
