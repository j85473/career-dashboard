import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import * as cheerio from 'cheerio';
import { callGemini } from '@/lib/gemini';
import { cleanHtmlText, generateFingerprint, normalizeUrl, resolveCanonicalUrl } from '@/lib/jobIngestion';
import { assertSafeExternalUrl, safeExternalFetch } from '@/lib/safeExternalFetch';
import { POST as scrapeJob } from '../[id]/scrape/route';

export async function POST(req: Request) {
  try {
    const { url, title: reqTitle, company: reqCompany, rescoreDuplicate } = await req.json();
    if (typeof url !== 'string' || !url.trim()) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    let validatedUrl: URL;
    try {
      validatedUrl = await assertSafeExternalUrl(url);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid URL' }, { status: 400 });
    }

    const parsed = validatedUrl;
    const domain = parsed.hostname.replace('www.', '');

    // The common duplicate case should be fast and must not disturb an
    // applied/interviewing/passed/archived decision or its scores.
    const normalizedInputUrl = normalizeUrl(validatedUrl.toString());
    const existingByUrl = await prisma.job.findFirst({
      where: {
        OR: [
          { url: url.trim() },
          ...(normalizedInputUrl ? [{ canonicalUrl: normalizedInputUrl }] : []),
        ],
      },
    });
    if (existingByUrl && rescoreDuplicate !== true) {
      const existingJob = await prisma.job.update({
        where: { id: existingByUrl.id },
        data: { tailoringStaged: true, updatedAt: existingByUrl.updatedAt },
      });
      return NextResponse.json({ job: existingJob, isDuplicate: true });
    }

    let title = reqTitle || 'Manual Job Import';
    let company = reqCompany || domain;
    let fallbackDesc = '';

    // 1. Fetch HTML to grab the actual title for parsing (only if not provided by API payload)
    if (!reqTitle || !reqCompany) {
      try {
        const htmlRes = await safeExternalFetch(validatedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: AbortSignal.timeout(10000),
        });
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
          } catch {
            // Fallback if AI fails
            title = pageTitle.substring(0, 50);
          }
        }
        
        // Grab some basic text as fallback description just in case the main scraper fails
        $('script, style, nav, header, footer').remove();
        fallbackDesc = cleanHtmlText($('body').html() || '').substring(0, 5000);
      }
      } catch {}

      // Deterministic fallback for blocked pages. Avoid spending an LLM call just
      // to turn a URL slug into a display label.
      if (title === 'Manual Job Import') {
        const candidateSlug = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) || '')
          .replace(/\b(?:job|jobs|position|opening)\b/gi, ' ')
          .replace(/\b[0-9a-f]{8,}\b/gi, ' ')
          .replace(/[-_]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (candidateSlug.length >= 4) {
          title = candidateSlug.replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 120);
        }
      }

    } // end if !reqTitle

    // 2. Resolve Canonical URL & Generate Fingerprint
    const canonicalUrl = await resolveCanonicalUrl({ company, title, url }) || url;
    const fingerprint = generateFingerprint(title, company, 'Unknown Location');
    
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
        data: { tailoringStaged: true, updatedAt: newJob.updatedAt }
      });
      if (rescoreDuplicate !== true) {
        return NextResponse.json({ job: newJob, isDuplicate: true });
      }
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
          scoringStatus: fallbackDesc.length >= 400 ? 'queued' : 'needs_jd',
          experienceStatus: 'queued',
          contextBatched: false,
          tailoringStaged: true,
        }
      });
    }

    // 3. Process immediately by calling the server handlers directly. This
    // avoids a self-fetch whose Host header could otherwise become an SSRF or
    // credential-exfiltration target.
    try {
      await scrapeJob(new Request('https://internal.invalid/api/jobs/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      }), { params: Promise.resolve({ id: newJob.id }) });
    } catch {}

    // Local/JD/DeepSeek processing remains in the normal queue. The scrape
    // handler schedules only this job for local scoring, so importing one URL
    // cannot unexpectedly process hundreds of unrelated records.
    const updatedJob = await prisma.job.findUnique({ where: { id: newJob.id } });

    return NextResponse.json({ job: updatedJob, isDuplicate });

  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
