import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jobInterviewsSelect } from '@/lib/jobInterviewOrder';
import { parseInterviewInput } from '@/lib/jobInterviewSchedule';

type Context = { params: Promise<{ id: string }> };

// Schedule edits only touch interview rows. They never change lifecycle or scoring.
async function mutate(request: Request, context: Context, method: 'POST' | 'PATCH' | 'DELETE') {
  const { id: jobId } = await context.params;
  let body;
  let input;
  try {
    body = await request.json();
    if (method !== 'DELETE') input = parseInterviewInput(body);
    if (method !== 'POST' && (typeof body?.id !== 'string' || !body.id.trim())) {
      throw new Error('Choose an interview to change.');
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid interview.' }, { status: 400 });
  }
  try {
    const result = await prisma.$transaction(async tx => {
      if (!await tx.job.findUnique({ where: { id: jobId }, select: { id: true } })) return null;
      if (method === 'POST') {
        await tx.jobInterview.create({ data: { jobId, ...input! } });
      } else {
        const where = { id: body.id, jobId };
        const changed = method === 'DELETE'
          ? await tx.jobInterview.deleteMany({ where })
          : await tx.jobInterview.updateMany({ where, data: input! });
        if (!changed.count) return null;
      }
      return tx.jobInterview.findMany({ where: { jobId }, ...jobInterviewsSelect });
    });
    if (result === null) return NextResponse.json({ error: 'Job or interview not found.' }, { status: 404 });
    return NextResponse.json({ interviews: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to save interview:', error);
    return NextResponse.json({ error: 'The interview could not be saved. Please try again.' }, { status: 500 });
  }
}

export const POST = (request: Request, context: Context) => mutate(request, context, 'POST');
export const PATCH = (request: Request, context: Context) => mutate(request, context, 'PATCH');
export const DELETE = (request: Request, context: Context) => mutate(request, context, 'DELETE');
