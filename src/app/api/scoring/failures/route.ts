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
  const receipts = await prisma.aimScoringFailureReceipt.findMany({
    where: { suppressionActive: true, clearedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
    select: {
      id: true,
      jobId: true,
      failureCode: true,
      permanence: true,
      seriesOrdinal: true,
      retrySeriesKey: true,
      suppressionKey: true,
      createdAt: true,
      failureSnapshot: true,
      job: { select: { company: true, title: true, status: true } },
    },
  });
  return Response.json({
    stage: 'aim',
    active: true,
    receipts: receipts.map((receipt) => ({
      ...receipt,
      createdAt: receipt.createdAt.toISOString(),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
