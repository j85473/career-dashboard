import { NextResponse } from 'next/server';
import {
  cleanHtmlText,
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

const SOURCE = 'LinkedIn (Apify)';

export async function POST(request: Request) {
  const startedAt = new Date();
  const counters = emptyExternalIngestionCounters();
  const context = externalIngestionContext(request, 'apify');
  let providerIncidentId: string | null = null;

  try {
    let datasetId = 'last';
    try {
      const body = await request.json();
      if (body?.datasetId !== undefined) {
        if (typeof body.datasetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.datasetId)) {
          return NextResponse.json({ error: 'Invalid Apify dataset ID.' }, { status: 400 });
        }
        datasetId = body.datasetId;
      }
    } catch {
      // Empty request bodies select the latest completed dataset.
    }

    const apiToken = process.env.APIFY_API_TOKEN;
    if (!apiToken) {
      const reason = 'APIFY_API_TOKEN is not configured';
      const ingestionStatus = await persistExternalIngestionSourceRun({
        source: SOURCE,
        counters,
        context,
        startedAt,
        status: 'disabled',
        error: reason,
      });
      return NextResponse.json({
        success: true,
        message: 'Apify job sync is disabled because APIFY_API_TOKEN is not configured.',
        details: reason,
        ingestionStatus,
        ingestionCounters: counters,
      });
    }

    const budget = await reserveProviderRequest({ provider: SOURCE, dailyLimit: 2 });
    if (!budget.allowed) throw new Error(`${SOURCE} request blocked by ${budget.reason}`);
    counters.requests = (counters.requests || 0) + 1;
    await recordJobPipelineEvent({
      eventType: 'provider_request',
      taskId: context.taskId,
      stage: 'provider',
      source: SOURCE,
      queryFamily: context.queryFamily,
      geoLane: context.geoLane,
      details: { requestNumber: counters.requests, datasetId },
      identityParts: [context.windowEnd?.toISOString() || startedAt.toISOString(), counters.requests],
    });

    const actorId = 'cheap_scraper~linkedin-job-scraper';
    const apiUrl = new URL('https://api.apify.com/');
    apiUrl.pathname = datasetId === 'last'
      ? `/v2/acts/${actorId}/runs/last/dataset/items`
      : `/v2/datasets/${datasetId}/items`;
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items: unknown = await response.json();
    if (!Array.isArray(items)) throw new Error('Invalid response schema: Apify dataset is not an array');
    await recordProviderSuccess(SOURCE);

    for (const rawItem of items) {
      try {
        const item = rawItem as Record<string, unknown>;
        const title = String(item.jobTitle || item.title || item.job_title || '').trim();
        const company = String(item.companyName || item.company_name || item.company || '').trim();
        const url = String(item.jobUrl || item.url || item.job_url || '').trim();
        if (!title || !company || !url) {
          countExternalIngestionOutcome(counters, 'processing_error');
          continue;
        }

        const location = String(item.location || item.jobLocation || '').trim() || 'Unknown Location';
        const description = cleanHtmlText(String(item.jobDescription || item.description || ''));
        const atsMatch = description.match(
          /https:\/\/(?:jobs\.lever\.co|boards\.greenhouse\.io|jobs\.ashbyhq\.com|[\w-]+\.wd[\w-]*\.myworkdayjobs\.com|[\w-]+\.workable\.com|jobs\.smartrecruiters\.com)\/[^\s<)"]+/i,
        );
        const canonicalUrl = atsMatch?.[0] || url;
        const source = atsMatch ? `${SOURCE} -> ATS` : SOURCE;
        const sourceId = String(item.id || canonicalUrl);
        const dateValue = item.publishedAt || item.date;
        const parsedDate = dateValue ? new Date(String(dateValue)) : undefined;

        const outcome = await ingestExternalJob({
          title,
          company,
          location,
          description,
          url: canonicalUrl,
          source,
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
        console.error('Error ingesting Apify job:', error);
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
      message: 'Apify sync completed successfully',
      jobsFetched: items.length,
      newJobsInserted: counters.inserted,
      ingestionStatus,
      ingestionCounters: counters,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    counters.providerErrors++;
    providerIncidentId = await recordProviderFailure({
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
    console.error('Error syncing with Apify:', error);
    return NextResponse.json({
      error: 'Apify job sync failed',
      details: message,
      ingestionStatus,
      ingestionCounters: counters,
    }, { status: 502 });
  }
}
