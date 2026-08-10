import { NextResponse } from 'next/server';
import {
  emptyExternalIngestionCounters,
  externalIngestionContext,
  persistExternalIngestionSourceRun,
} from '@/lib/jobIngestion';

/** Generic issues labelled "hiring" are not a dependable sales-job feed. */
export async function POST(request?: Request) {
  const startedAt = new Date();
  const counters = emptyExternalIngestionCounters();
  const context = externalIngestionContext(request, 'disabled-low-signal');
  const reason = 'Disabled: generic GitHub hiring issues lack dependable job-schema and target-sales relevance.';
  const ingestionStatus = await persistExternalIngestionSourceRun({
    source: 'GitHub hiring issues',
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
