import { NextResponse } from 'next/server';
import {
  emptyExternalIngestionCounters,
  externalIngestionContext,
  persistExternalIngestionSourceRun,
} from '@/lib/jobIngestion';

/**
 * Reddit hiring posts do not provide a reliable employer, work-base, or
 * requisition contract. Keep the route explicit and observable, but disabled,
 * instead of fabricating "Remote" jobs and sending noisy records to scoring.
 */
export async function POST(request?: Request) {
  const startedAt = new Date();
  const counters = emptyExternalIngestionCounters();
  const context = externalIngestionContext(request, 'disabled-low-signal');
  const reason = 'Disabled: unstructured Reddit posts lack reliable employer, work-base, and requisition identity.';
  const ingestionStatus = await persistExternalIngestionSourceRun({
    source: 'Reddit hiring posts',
    counters,
    context,
    startedAt,
    status: 'disabled',
    error: reason,
  });
  return NextResponse.json({
    success: true,
    disabled: true,
    message: reason,
    details: reason,
    ingestionStatus,
    ingestionCounters: counters,
  });
}
