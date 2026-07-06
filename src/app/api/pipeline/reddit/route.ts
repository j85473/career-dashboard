import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
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
        
        // Check if job already exists
        const existingJob = await prisma.job.findFirst({
          where: { url: jobUrl }
        });
        
        if (!existingJob) {
          await prisma.job.create({
            data: {
              title: item.title.replace(/\[Hiring\]/gi, '').trim(),
              company: `Reddit (r/${sub})`,
              location: 'Remote / Unknown',
              description: item.selftext || '',
              url: jobUrl,
              source: `Reddit (r/${sub})`,
              status: 'pending_af', // Bypass JD extraction, go straight to AI Evaluator
              scoringStatus: 'scored',
              luckyStatus: 'none',
              postedAt: new Date(item.created_utc * 1000)
            }
          });
          insertedCount++;
        }
      }
    }

    return NextResponse.json({ 
      message: 'Reddit sync completed successfully', 
      newJobsInserted: insertedCount 
    });

  } catch (error: any) {
    console.error('Error syncing with Reddit:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error.message }, { status: 500 });
  }
}
