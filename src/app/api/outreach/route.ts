import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET() {
  try {
    const targets = await prisma.outreachTarget.findMany({
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json({ targets });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
