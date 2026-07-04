import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { reason } = await request.json();
    const resolvedParams = await params;

    if (!reason || reason.trim() === '') {
      return NextResponse.json({ error: "Reason is required" }, { status: 400 });
    }

    // Add the positive constraint
    await prisma.userPreference.create({
      data: {
        text: reason,
        type: 'boost'
      }
    });

    // Update job to inbox and promoted
    const job = await prisma.job.update({
      where: { id: resolvedParams.id },
      data: {
        status: 'inbox',
        passReason: `Promoted by user: ${reason}`
      }
    });

    return NextResponse.json(job);
  } catch (error) {
    console.error("Error promoting job:", error);
    return NextResponse.json({ error: "Failed to promote job" }, { status: 500 });
  }
}
