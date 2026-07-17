import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { applyWildcardDecision, WildcardDecisionError } from '@/lib/wildcardDecision';
import { updateContextProfile } from '@/lib/contextBuilder';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { reason = 'Manually promoted by user', scope } = await request.json();
    const resolvedParams = await params;

    if (scope === 'wildcard') {
      const job = await prisma.$transaction((tx) => applyWildcardDecision(tx, resolvedParams.id, 'promote', reason));

      return NextResponse.json({ job });
    }

    const job = await prisma.$transaction(async (tx) => {

      return tx.job.update({
        where: { id: resolvedParams.id },
        data: {
          status: 'inbox',
          luckyStatus: 'none',
          passReason: `Promoted by user: ${reason.trim()}`
        }
      });
    });

    // We no longer send 'applied' actions to the Context Profile to prevent 
    // bridge roles from watering down the master archetype.
    
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof WildcardDecisionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error promoting job:", error);
    return NextResponse.json({ error: "Failed to promote job" }, { status: 500 });
  }
}
