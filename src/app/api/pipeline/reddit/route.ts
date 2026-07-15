import { NextResponse } from 'next/server';
import { ingestExternalJob } from '@/lib/jobIngestion';

export async function POST() {
  try {
    const subreddits = ['forhire', 'jobbit'];
    let insertedCount = 0;
    
    for (const sub of subreddits) {
      console.log(`Fetching Reddit feed for r/${sub}...`);
      const url = `https://www.reddit.com/r/${sub}/new.json?limit=50`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
      if (!response.ok) {
        console.error(`Failed to fetch r/${sub}: ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      const posts = data?.data?.children || [];
      
      for (const post of posts) {
        const item = post.data;
        // Only target posts from employers looking to hire
        if (!item.title.toLowerCase().includes('[hiring]')) {
          continue;
        }
        
        const jobUrl = `https://www.reddit.com${item.permalink}`;
        
        const source = `Reddit (r/${sub})`;
        const outcome = await ingestExternalJob({
          title: item.title.replace(/\[Hiring\]/gi, '').trim(),
          company: source,
          location: 'Remote / Unknown',
          description: item.selftext || '',
          url: jobUrl,
          source,
          sourceId: String(item.id || item.name || item.permalink),
          postedAt: new Date(item.created_utc * 1000),
        });
        if (outcome === 'inserted') insertedCount++;
      }
    }

    return NextResponse.json({ 
      message: 'Reddit sync completed successfully', 
      newJobsInserted: insertedCount 
    });

  } catch (error: unknown) {
    console.error('Error syncing with Reddit:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
