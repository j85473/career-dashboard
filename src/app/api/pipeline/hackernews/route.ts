import { NextResponse } from 'next/server';
import {
  emptyExternalIngestionCounters,
  externalIngestionContext,
  persistExternalIngestionSourceRun,
} from '@/lib/jobIngestion';

/** HN monthly-thread comments are multi-role prose, not stable job records. */
export async function POST(request?: Request) {
  const startedAt = new Date();
  const counters = emptyExternalIngestionCounters();
  const context = externalIngestionContext(request, 'disabled-low-signal');
  const reason = 'Disabled: HN hiring comments cannot be split into reliable title, employer, location, and requisition records.';
  const ingestionStatus = await persistExternalIngestionSourceRun({
    source: 'Hacker News hiring thread',
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
