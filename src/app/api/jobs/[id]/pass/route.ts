import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request, context: any) {
  const { id } = await context.params;
  const body = await request.json();
  const { reason } = body;
  
  if (!reason) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }

  try {
    // 1. Mark job as passed
    const job = await prisma.job.update({
      where: { id },
      data: { 
        status: 'passed',
        passReason: reason
      }
    });



    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to pass job' }, { status: 500 });
  }
}
