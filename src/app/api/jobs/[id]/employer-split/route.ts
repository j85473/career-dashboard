import { NextResponse } from 'next/server';

import { recordEmployerSplit } from '@/lib/companyNameStandardization';
import { employerAliasKey } from '@/lib/employerIdentity';
import { prisma } from '@/lib/prisma';

/**
 * Joseph says this card's spelling names a different employer from the one
 * evidence grouped it under. The spelling keeps its own name from now on, and
 * the group keeps its name, so they are never joined again.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const job = await prisma.$transaction(async (tx) => {
      const current = await tx.job.findUnique({ where: { id }, select: { company: true, employer: true } });
      if (!current) return null;
      if (!current.employer || employerAliasKey(current.company) === employerAliasKey(current.employer)) {
        throw new EmployerSplitRefused('This card already shows its own employer name.');
      }
      const ownName = await recordEmployerSplit(tx, { company: current.company, groupEmployer: current.employer, jobId: id });
      // A name correction is not activity on the card; keep its last-updated time.
      await tx.$executeRaw`UPDATE "Job" SET "employer" = ${ownName} WHERE "id" = ${id}`;
      return tx.job.findUnique({ where: { id } });
    });
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof EmployerSplitRefused) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error('Failed to separate an employer:', error);
    return NextResponse.json({ error: 'The employer could not be separated.' }, { status: 500 });
  }
}

class EmployerSplitRefused extends Error {}
