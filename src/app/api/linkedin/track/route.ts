import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(req: Request) {
  try {
    const { url, status } = await req.json();
    
    if (!url || !status) {
      return NextResponse.json({ error: 'URL and status are required' }, { status: 400 });
    }

    // Normalize URL
    let normalized = url.toLowerCase().trim();
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    await prisma.usedArticle.upsert({
      where: { url: normalized },
      update: { status },
      create: { url: normalized, status },
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Track error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
