import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { applyWildcardDecision, WildcardDecisionError } from '@/lib/wildcardDecision';
import { updateContextProfile } from '@/lib/contextBuilder';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { reason, scope } = await request.json();
    const resolvedParams = await params;

    if (typeof reason !== 'string' || reason.trim() === '') {
      return NextResponse.json({ error: "Reason is required" }, { status: 400 });
    }

    if (scope === 'wildcard') {
      const job = await prisma.$transaction((tx) => applyWildcardDecision(tx, resolvedParams.id, 'promote', reason));
      return NextResponse.json({ job });
    }

    const job = await prisma.$transaction(async (tx) => {
      await tx.userPreference.create({
        data: {
          text: reason.trim(),
          type: 'boost'
        }
      });

      return tx.job.update({
        where: { id: resolvedParams.id },
        data: {
          status: 'inbox',
          luckyStatus: 'none',
          passReason: `Promoted by user: ${reason.trim()}`
        }
      });
    });

    updateContextProfile(resolvedParams.id, 'applied', reason).catch(e => console.error(e));

    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof WildcardDecisionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error promoting job:", error);
    return NextResponse.json({ error: "Failed to promote job" }, { status: 500 });
  }
}
