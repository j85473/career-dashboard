import { NextResponse } from 'next/server';
import { readJobJdPdfCapture, requestJobJdPdfCapture } from '@/lib/jobJdPdfCapture';
import { scheduleJobJdPdfCapture } from '@/lib/jobJdPdfCaptureBackground';

export const runtime = 'nodejs';
export const maxDuration = 90;
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const result = await readJobJdPdfCapture(id);
  if (!result) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  // A queued attempt survives a web-process restart and resumes when its card is opened.
  if (result.capture?.status === 'queued') scheduleJobJdPdfCapture(id, result.capture.attemptId);
  return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    const result = await requestJobJdPdfCapture(id);
    if (result.shouldRun && result.capture) scheduleJobJdPdfCapture(id, result.capture.attemptId);
    return NextResponse.json(await readJobJdPdfCapture(id), {
      status: result.shouldRun ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not start PDF capture.' }, { status: 400 });
  }
}
