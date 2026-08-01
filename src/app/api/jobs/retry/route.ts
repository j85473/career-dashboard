import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({
    error: 'Legacy per-job scoring retry is retired. Retry the durable native scoring request instead.',
    endpoint: '/api/scoring/requests/{requestId}/retry',
  }, { status: 410 });
}
