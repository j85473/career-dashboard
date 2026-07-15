import { NextResponse } from 'next/server';
import { ingestExternalJob } from '@/lib/jobIngestion';
import "dotenv/config";

export async function POST() {
  try {
    let insertedCount = 0;
    const GITHUB_TOKEN = process.env.GITHUB_API_TOKEN;

    if (!GITHUB_TOKEN) {
      console.warn("⚠️ No GITHUB_API_TOKEN found in .env. Skipping GitHub pipeline.");
      return NextResponse.json({ message: 'Missing GITHUB_API_TOKEN, skipping sync' });
    }

    // 1. Search for recent open issues with the label "hiring"
    // To keep it fresh and relevant, we sort by created date and take the first page.
    const searchUrl = 'https://api.github.com/search/issues?q=label:hiring+state:open+type:issue&sort=created&order=desc&per_page=30';
    
    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Antigravity-Career-Dashboard'
      }
    });
    
    if (!searchRes.ok) {
      const errorText = await searchRes.text();
      console.error('Failed to search GitHub API:', errorText);
      return NextResponse.json({ error: 'Failed to search GitHub API' }, { status: 500 });
    }
    
    const searchData = await searchRes.json();
    const issues = searchData.items || [];
    
    // 2. Process the issues
    for (const issue of issues) {
      if (!issue.body) continue;
      
      const jobUrl = issue.html_url;
      
      const title = issue.title.substring(0, 200).trim();
      const companyMatch = issue.repository_url.match(/repos\/([^\/]+)\//);
      const company = companyMatch ? companyMatch[1] : 'GitHub Open Source';
      const outcome = await ingestExternalJob({
        title,
        company,
        location: 'Remote / Unknown',
        description: issue.body,
        url: jobUrl,
        source: 'GitHub Issues',
        sourceId: String(issue.id || issue.node_id || jobUrl),
        postedAt: new Date(issue.created_at),
      });
      if (outcome === 'inserted') insertedCount++;
    }

    return NextResponse.json({ 
      message: 'GitHub Issues sync completed successfully', 
      totalFound: issues.length,
      newJobsInserted: insertedCount 
    });

  } catch (error: unknown) {
    console.error('Error syncing with GitHub Issues:', error);
    return NextResponse.json({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
