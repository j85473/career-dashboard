import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function POST(req: Request) {
  try {
    const payload = await req.json();
    
    if (!Array.isArray(payload)) {
      return NextResponse.json({ error: 'Payload must be an array of JSON objects' }, { status: 400 });
    }

    let inserted = 0;
    for (const item of payload) {
      if (!item.linkedinUrl) continue;

      let company = 'N/A';
      if (item.currentPosition && item.currentPosition.length > 0) {
        company = item.currentPosition[0].companyName || 'N/A';
      }

      await prisma.outreachTarget.upsert({
        where: { linkedinUrl: item.linkedinUrl },
        update: {}, // do nothing if it already exists
        create: {
          publicIdentifier: item.publicIdentifier || null,
          firstName: item.firstName || '',
          lastName: item.lastName || '',
          headline: item.headline || '',
          company: company,
          email: item.emails?.[0]?.email || item.email || item.emailAddress || item.contactEmail || null,
          linkedinUrl: item.linkedinUrl,
          about: item.about || '',
          locationText: item.location?.linkedinText || '',
          status: 'inbox',
        }
      });
      inserted++;
    }

    return NextResponse.json({ success: true, count: inserted });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
