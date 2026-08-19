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
const DICE_ACTOR = 'worldunboxer/dice-jobs-scraper';
/** The Apify schedule runs daily at 03:10; allow a wide margin before alarming. */
const MAX_DATASET_AGE_HOURS = 36;

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
    // READ the last run; never `.call()`. The actor is on an Apify-side
    // schedule (03:10), and `.call()` starts an additional run and bills for
    // it — this endpoint was firing near midnight, so the scraper ran and was
    // paid for twice a day. This route's job is to pull results in, nothing
    // more. `apify-profiles` and `outreach/apify-sync` already work this way.
    const lastRun = await client.actor(DICE_ACTOR).lastRun({ status: 'SUCCEEDED' }).get();
    if (!lastRun?.defaultDatasetId) {
      throw new Error(`No succeeded run found for ${DICE_ACTOR}; nothing to ingest`);
    }
    // A stale dataset means the Apify schedule stopped firing. Re-ingesting
    // last week's listings would look like a healthy run and quietly hide that.
    const finishedAt = lastRun.finishedAt ? new Date(lastRun.finishedAt).getTime() : 0;
    const ageHours = finishedAt ? (Date.now() - finishedAt) / 3_600_000 : Number.POSITIVE_INFINITY;
    if (ageHours > MAX_DATASET_AGE_HOURS) {
      throw new Error(
        `${DICE_ACTOR} last succeeded ${Number.isFinite(ageHours) ? `${Math.round(ageHours)}h` : 'an unknown time'} ago; `
        + `expected a run within ${MAX_DATASET_AGE_HOURS}h. Check the Apify schedule rather than re-ingesting stale items.`,
      );
    }
    const { items } = await client.dataset(lastRun.defaultDatasetId).listItems();
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
