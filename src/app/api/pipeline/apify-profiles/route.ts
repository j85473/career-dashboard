import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST() {
  try {
    const apiToken = process.env.APIFY_API_TOKEN;
    
    if (!apiToken) {
      return NextResponse.json({ error: 'APIFY_API_TOKEN is not set in environment variables.' }, { status: 500 });
    }

    // Fetch the dataset from the last run of the linkedin-profile-search actor
    // The actor ID found previously was M2FMdjRVeF1HPGFcc
    const actorId = 'M2FMdjRVeF1HPGFcc';
    const apiUrl = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items`;
    

    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(20000),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Apify Profiles API Error:', errorText);
      return NextResponse.json({ error: 'Failed to fetch profiles from Apify', details: errorText }, { status: response.status });
    }

    const items = await response.json();


    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: true, message: 'No profiles found in the latest run.', profilesFetched: 0, newProfilesInserted: 0 });
    }

    let insertedCount = 0;

    for (const item of items) {
      const url = item.url || item.linkedinUrl || item.publicIdentifier;
      const firstName = item.firstName;
      const lastName = item.lastName;
      
      // Skip invalid items
      if (!url || !firstName || !lastName) {
        continue;
      }

      try {
        // Upsert to ignore duplicates, or create if not exists
        await prisma.outreachTarget.upsert({
          where: { linkedinUrl: url },
          update: {}, // Don't update anything if it already exists, keep their statuses and pitches intact
          create: {
            publicIdentifier: item.publicIdentifier || null,
            firstName,
            lastName,
            headline: item.headline || item.title || '',
            company: item.company || item.currentCompany || '',
            email: item.email || null,
            linkedinUrl: url,
            about: item.about || item.summary || '',
            locationText: item.location || item.locationText || '',
            status: 'inbox'
          }
        });
        insertedCount++;
      } catch {
        // Ignoring individual errors so the loop continues
      }
    }

    return NextResponse.json({ 
      success: true,
      message: 'Apify profiles sync completed successfully', 
      profilesFetched: items.length, 
      newProfilesInserted: insertedCount 
    });

  } catch (error: unknown) {
    console.error('Error syncing profiles with Apify:', error);
    return NextResponse.json({
      error: 'Internal Server Error',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
