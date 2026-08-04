import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';


export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { reason = 'Manually promoted by user' } = await request.json();
    const resolvedParams = await params;

    const job = await prisma.$transaction(async (tx) => {

      return tx.job.update({
        where: { id: resolvedParams.id },
        data: {
          status: 'inbox',
          passReason: `Promoted by user: ${reason.trim()}`,
          contextBatched: true,
          contextBatchId: null,
        }
      });
    });

    // We no longer send 'applied' actions to the Context Profile to prevent 
    // bridge roles from watering down the master archetype.
    
    return NextResponse.json({ job });
  } catch (error) {
    console.error("Error promoting job:", error);
    return NextResponse.json({ error: "Failed to promote job" }, { status: 500 });
  }
}
