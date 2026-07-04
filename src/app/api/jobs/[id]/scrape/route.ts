import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import * as cheerio from 'cheerio';
import { identifyAts, resolveRedirectUrl } from '@/lib/atsUtils';
import { cleanHtmlText } from '@/lib/jobIngestion';
import { scrapeAtsApi } from '@/lib/atsApi';
import { scoreJobs } from '@/lib/jobScoring';

function cleanUrl(url: string) {
  try {
    const parsed = new URL(url);
    // Remove common tracking params
    ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'].forEach(param => {
      parsed.searchParams.delete(param);
    });
    return parsed.toString();
  } catch (e) {
    return url;
  }
}


export async function POST(request: Request, context: any) {
  const { id } = await context.params;
  const { url, skipRescore } = await request.json();
  
  if (!url) {
    return NextResponse.json({ error: 'URL required' }, { status: 400 });
  }

  const resolvedUrl = await resolveRedirectUrl(url);
  const cleanedUrl = cleanUrl(resolvedUrl);
  const detectedAts = identifyAts({ url: cleanedUrl });
  
  // Pre-update the job so the ATS badge shows up even if scraping fails (bot protection)
  await prisma.job.update({
    where: { id },
    data: {
      url: cleanedUrl,
      manualAts: detectedAts !== 'Unknown' ? detectedAts : undefined
    }
  });
  
  try {
    let descriptionText = '';
    let manualAts = detectedAts;
    let foundSlug = '';
    let foundPlatform = '';

    // 1. Try ATS specific API
    const atsResult = await scrapeAtsApi(cleanedUrl);
    
    if (atsResult) {
      descriptionText = atsResult.text;
      manualAts = atsResult.ats;
      foundSlug = atsResult.atsSlug || '';
      foundPlatform = atsResult.platform || '';
    } else {
      // 2. Fallback to Jina API for reliable Markdown extraction (bypasses SPAs/Bots)
      const res = await fetch(`https://r.jina.ai/${cleanedUrl}`);
      if (!res.ok) throw new Error('Jina Fetch failed');
      
      const markdown = await res.text();
      if (markdown && markdown.length > 500) {
        descriptionText = markdown;
      } else {
        throw new Error('Scraped text is too short, likely bot protection or SPA');
      }
    }

    // Upsert into AtsCompany if we found a direct API link
    if (foundSlug && foundPlatform) {
      await prisma.atsCompany.upsert({
        where: {
          slug_platform: { slug: foundSlug, platform: foundPlatform }
        },
        update: {
          status: 'active', // Reactivate if it was parked
          nextCheckDate: new Date(),
        },
        create: {
          slug: foundSlug,
          platform: foundPlatform,
          status: 'active',
          nextCheckDate: new Date(),
          failCount: 0,
          jobsFound: 1, // Assume at least 1 job found
        }
      });
    }

    // Update job and trigger rescore
    const updatedJob = await prisma.job.update({
      where: { id },
      data: {
        url: cleanedUrl,
        description: descriptionText,
        manualAts: manualAts || undefined,
        ...(skipRescore ? {} : { scoringStatus: 'queued', fitCategory: 'unscored' })
      }
    });

    // Fire and forget local scoring since it's fast (only if not skipping rescore)
    if (!skipRescore) {
      try {
        scoreJobs().catch(e => console.error('Auto-scoring failed:', e));
      } catch(e) {}
    }

    return NextResponse.json({ job: updatedJob });

  } catch (error: any) {
    console.error("Scraping failed:", error);
    const updatedJob = await prisma.job.findUnique({ where: { id } });
    return NextResponse.json({ 
      error: 'Scraping failed: ' + error.message, 
      needManual: true,
      job: updatedJob
    }, { status: 500 });
  }
}
