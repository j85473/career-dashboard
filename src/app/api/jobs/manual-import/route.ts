import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { scoreJobs } from '@/lib/jobScoring';
import * as cheerio from 'cheerio';
import { callGemini } from '@/lib/gemini';
import { cleanHtmlText, resolveCanonicalUrl, generateFingerprint } from '@/lib/jobIngestion';

export async function POST(req: Request) {
  try {
    const { url, title: reqTitle, company: reqCompany } = await req.json();
    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname.startsWith('169.254.') ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
      ) {
        return NextResponse.json({ error: 'Invalid URL: Internal addresses are not allowed' }, { status: 400 });
      }
    } catch (e) {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    const parsed = new URL(url);
    const domain = parsed.hostname.replace('www.', '');

    let title = reqTitle || 'Manual Job Import';
    let company = reqCompany || domain;
    let fallbackDesc = '';

    // 1. Fetch HTML to grab the actual title for parsing (only if not provided by API payload)
    if (!reqTitle || !reqCompany) {
      try {
        const htmlRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }});
      if (htmlRes.ok) {
        const html = await htmlRes.text();
        const $ = cheerio.load(html);
        const pageTitle = $('title').text().trim();
        
        if (pageTitle) {
          // Use Gemini to quickly parse the title tag into Company & Job Title
          const prompt = `Extract the specific Job Title and Company Name from this webpage title tag: "${pageTitle}". Return only a raw JSON object with keys "title" and "company". If you cannot determine the company, use "${domain}". Do not use markdown blocks.`;
          try {
            const jsonStr = await callGemini(prompt);
            if (jsonStr) {
              const parsedJson = JSON.parse(jsonStr.replace(/```json/g, '').replace(/```/g, '').trim());
              if (parsedJson.title) title = parsedJson.title;
              if (parsedJson.company) company = parsedJson.company;
            }
          } catch(e) {
            // Fallback if AI fails
            title = pageTitle.substring(0, 50);
          }
        }
        
        // Grab some basic text as fallback description just in case the main scraper fails
        $('script, style, nav, header, footer').remove();
        fallbackDesc = cleanHtmlText($('body').html() || '').substring(0, 5000);
      }
      } catch(e) {}

      // Fallback: If title is still 'Manual Job Import' (e.g. fetch was blocked like LinkedIn 999/403), try extracting from the URL string itself
      if (title === 'Manual Job Import') {
        const prompt = `Extract the likely Job Title and Company Name from this URL string: "${url}". Return only a raw JSON object with keys "title" and "company". If you cannot determine the company, use "${domain}". Do not use markdown blocks or formatting.`;
        try {
          const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
              model: "deepseek-v4-pro",
              messages: [{ role: "user", content: prompt }],
              temperature: 0.1
            })
          });
          const dsData = await dsRes.json();
          const jsonStr = dsData.choices?.[0]?.message?.content;
          
          if (jsonStr) {
            const parsedJson = JSON.parse(jsonStr.replace(/```json/g, '').replace(/```/g, '').trim());
            if (parsedJson.title && parsedJson.title !== 'Manual Job Import') title = parsedJson.title;
            if (parsedJson.company) company = parsedJson.company;
          }
        } catch(e) {
          console.error('URL extraction fallback failed', e);
        }
      }

    } // end if !reqTitle

    // 2. Resolve Canonical URL & Generate Fingerprint
    const canonicalUrl = await resolveCanonicalUrl({ company, title, url }) || url;
    const fingerprint = generateFingerprint(title, company, canonicalUrl);
    
    // 3. Find existing or Create the Job
    let newJob = await prisma.job.findFirst({ 
      where: { 
        OR: [
          { fingerprint },
          { url },
          { canonicalUrl: canonicalUrl }
        ]
      } 
    });
    
    let isDuplicate = false;

    if (newJob) {
      isDuplicate = true;
      newJob = await prisma.job.update({
        where: { id: newJob.id },
        data: { tailoringStaged: true }
      });
    } else {
      newJob = await prisma.job.create({
        data: {
          title: title,
          company: company,
          url: url,
          canonicalUrl: canonicalUrl,
          fingerprint: fingerprint,
          description: fallbackDesc, // will be overwritten if scrape succeeds
          source: 'Manual Import',
          postedAt: new Date(),
          status: 'pending_af',
          scoringStatus: 'scored',
          experienceStatus: 'scored',
          contextBatched: false,
          tailoringStaged: true,
        }
      });
    }

    // 3. Process immediately via internal API calls (Fire and forget where possible, or await to ensure completion)
    
    // A) Scrape JD properly
    const host = new URL(req.url).origin;
    
    try {
      await fetch(`${host}/api/jobs/${newJob.id}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
    } catch(e) {}

    // B) Run local heuristic scoring
    try {
      await scoreJobs();
    } catch(e) {}

    // C) Fire and forget Gemini Experience Batch & Context DB
    fetch(`${host}/api/jobs/batch-jd-submit`, { method: 'POST' }).catch(()=>{});
    fetch(`${host}/api/jobs/batch-context`, { method: 'POST' }).catch(()=>{});

    // Fetch the updated job after scoring
    const updatedJob = await prisma.job.findUnique({ where: { id: newJob.id } });

    return NextResponse.json({ job: updatedJob, isDuplicate });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
