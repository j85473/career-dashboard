import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const companies = await prisma.atsCompany.findMany({
      where: { status: 'active' },
      orderBy: { slug: 'asc' }
    });
    return NextResponse.json({ companies });
  } catch (error: any) {
    console.error("Failed to fetch ATS companies:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
