import { NextResponse } from 'next/server';
import { ingestExternalJob } from '@/lib/jobIngestion';

export async function POST() {
  try {
    let insertedCount = 0;
    
    // 1. Find the latest "Who is hiring" thread
    const searchUrl = 'https://hn.algolia.com/api/v1/search_by_date?tags=story&query="Ask+HN:+Who+is+hiring?"';
    const searchRes = await fetch(searchUrl);
    
    if (!searchRes.ok) {
      return NextResponse.json({ error: 'Failed to search HN Algolia' }, { status: 500 });
    }
    
    const searchData = await searchRes.json();
    const latestThread = searchData.hits?.[0];
    
    if (!latestThread) {
      return NextResponse.json({ message: 'No hiring threads found.' });
    }
    
    // 2. Fetch the full thread with all comments
    const threadUrl = `https://hn.algolia.com/api/v1/items/${latestThread.objectID}`;
    const threadRes = await fetch(threadUrl);
    
    if (!threadRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch HN thread details' }, { status: 500 });
    }
    
    const threadData = await threadRes.json();
    const comments = threadData.children || [];
    
    // 3. Process the comments
    for (const comment of comments) {
      if (!comment.text) continue;
      
      // Basic filtering to ensure it's likely a job posting
      // Usually founders post "Company | Role | Location | Onsite/Remote | Full-time" etc.
      // We'll skip very short comments that are likely replies instead of job postings.
      if (comment.text.length < 150) continue;
      
      const jobUrl = `https://news.ycombinator.com/item?id=${comment.id}`;
      
      const rawText = comment.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const title = rawText.split('|')[0]?.substring(0, 100).trim() || 'Hacker News Job Posting';
      const outcome = await ingestExternalJob({
        title,
        company: 'Hacker News Startup',
        location: 'Remote / Unknown',
        description: comment.text,
        url: jobUrl,
        source: 'Hacker News (Who is hiring)',
        sourceId: String(comment.objectID || comment.id),
        postedAt: new Date(comment.created_at),
      });
      if (outcome === 'inserted') insertedCount++;
    }

    return NextResponse.json({ 
      message: 'Hacker News sync completed successfully', 
      threadId: latestThread.objectID,
      newJobsInserted: insertedCount 
    });

  } catch (error: unknown) {
    console.error('Error syncing with Hacker News:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
