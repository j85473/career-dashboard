import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const res = await prisma.job.updateMany({
    data: { afBatchId: null, luckyBatchId: null },
  });
  return NextResponse.json({ message: 'Released', count: res.count });
}
