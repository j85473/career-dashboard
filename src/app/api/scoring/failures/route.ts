import { currentAimFailureSuppressions } from '@/lib/currentAimFailureSuppression';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stage = url.searchParams.get('stage');
  const active = url.searchParams.get('active');
  if (stage !== 'aim' || active !== 'true') {
    return Response.json({ error: 'only stage=aim&active=true is supported' }, { status: 400 });
  }
  const receipts = (await currentAimFailureSuppressions(prisma)).slice(0, 100);
  return Response.json({
    stage: 'aim',
    active: true,
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      jobId: receipt.jobId,
      failureCode: receipt.failureCode,
      permanence: receipt.permanence,
      seriesOrdinal: receipt.seriesOrdinal,
      retrySeriesKey: receipt.retrySeriesKey,
      suppressionKey: receipt.suppressionKey,
      createdAt: receipt.createdAt.toISOString(),
      failureSnapshot: receipt.failureSnapshot,
      job: {
        company: receipt.job.company,
        title: receipt.job.title,
        status: receipt.job.status,
      },
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
