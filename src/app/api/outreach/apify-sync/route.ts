import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET() {
  try {
    const apiToken = process.env.APIFY_API_TOKEN;
    
    if (!apiToken) {
      return NextResponse.json({ error: 'APIFY_API_TOKEN is not set in environment variables.' }, { status: 500 });
    }

    // Fetch the dataset from the last run of the harvestapi~linkedin-profile-search actor
    const actorId = 'harvestapi~linkedin-profile-search';
    const apiUrl = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items?token=${apiToken}`;
    
    console.log('Fetching Apify dataset from:', apiUrl);
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Apify API Error:', errorText);
      return NextResponse.json({ error: 'Failed to fetch dataset from Apify', details: errorText }, { status: response.status });
    }

    const items = await response.json();
    console.log(`Received ${items.length} items from Apify.`);

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ message: 'No profiles found in the latest run.' });
    }

    let insertedCount = 0;

    for (const item of items) {
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
          linkedinUrl: item.linkedinUrl,
          about: item.about || '',
          locationText: item.location?.linkedinText || '',
          status: 'inbox',
        }
      });
      insertedCount++;
    }

    return NextResponse.json({ 
      success: true, 
      message: 'Apify sync completed successfully', 
      profilesFetched: items.length, 
      newProfilesInserted: insertedCount 
    });

  } catch (error: any) {
    console.error('Error syncing with Apify:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error.message }, { status: 500 });
  }
}
