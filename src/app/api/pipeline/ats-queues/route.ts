import { NextResponse } from 'next/server';
import { readAtsQueueTelemetry } from '@/lib/atsQueueTelemetry';

export async function GET() {
  try {
    return NextResponse.json(await readAtsQueueTelemetry(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'ATS queue diagnostics temporarily unavailable.' }, { status: 503 });
  }
}
