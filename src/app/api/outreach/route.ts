import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET() {
  try {
    const targets = await prisma.outreachTarget.findMany({
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json({ targets });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
