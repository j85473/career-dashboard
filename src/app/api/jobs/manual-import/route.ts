import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { callGemini } from '@/lib/gemini';
import {
  generateV4Fingerprint,
  resolveCanonicalUrl,
  normalizeUrl,
} from '@/lib/jobIngestion';
import { assertSafeExternalUrl, safeExternalFetch } from '@/lib/safeExternalFetch';
import { POST as scrapeJob } from '../[id]/scrape/route';
import type { Job } from '@prisma/client';
import { findSameRoleCard, jobCardSummary } from '@/lib/appliedRepeatActions';
import { CONSOLIDATED_REASON_PREFIX, urlPostingIdentity } from '@/lib/jobUrlReconciliation';
import { resolveEmployerForNewJob } from '@/lib/employerRuleStore';
import { readManualImportPage } from '@/lib/manualImportPage';
import {
  MANUAL_IMPORT_INITIAL_LIFECYCLE,
  MANUAL_IMPORT_SOURCE,
} from '@/lib/manualImportPolicy';

const CONSOLIDATED_INTO = new RegExp(`^${CONSOLIDATED_REASON_PREFIX}(.+)$`);

/** A card folded into another points at the survivor; follow it so the answer names a card Joseph can open. */
async function followConsolidation<T extends { id: string; passReason: string | null }>(job: T): Promise<T | Job> {
  let current: T | Job = job;
  for (let hop = 0; hop < 5; hop += 1) {
    const survivorId: string | undefined = current.passReason?.match(CONSOLIDATED_INTO)?.[1];
    if (!survivorId) return current;
    const survivor: Job | null = await prisma.job.findUnique({ where: { id: survivorId } });
    if (!survivor) return current;
    current = survivor;
  }
  return current;
}

async function findSurvivingCardForLink(url: string, normalizedUrl: string): Promise<Job | null> {
  const postingIdentity = urlPostingIdentity(normalizedUrl || url);
  const rows = await prisma.job.findMany({
    where: {
      OR: [
        { url },
        ...(normalizedUrl ? [{ canonicalUrl: normalizedUrl }, { url: normalizedUrl }] : []),
        ...(postingIdentity ? [{ postingIdentity }] : []),
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });
  const direct = rows.find((row) => !row.passReason?.startsWith(CONSOLIDATED_REASON_PREFIX));
  if (direct) return direct;
  return rows[0] ? followConsolidation(rows[0]) : null;
}

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

    // A link already saved is reported, not acted on: the card keeps its
    // status, scores and tailoring state, and Joseph decides what to do next.
    const normalizedInputUrl = normalizeUrl(validatedUrl.toString());
    const existingByUrl = await findSurvivingCardForLink(url.trim(), normalizedInputUrl);
    if (existingByUrl && rescoreDuplicate !== true) {
      return NextResponse.json({
        job: existingByUrl,
        isDuplicate: true,
        match: { kind: 'same_link', job: await jobCardSummary(existingByUrl.id), evidence: null },
      });
    }

    let title = reqTitle || 'Manual Job Import';
    let company = reqCompany || domain;
    let location: string | undefined;
    let fallbackDesc = '';

    // Read the posting's authored metadata before creating the card. A later
    // best-effort refresh must not be required to replace an ATS hostname.
    if (!reqTitle || !reqCompany) {
      try {
        const htmlRes = await safeExternalFetch(validatedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: AbortSignal.timeout(10000),
        });
        if (htmlRes.ok) {
          const metadata = await readManualImportPage({
            html: await htmlRes.text(), url: validatedUrl.toString(), title: reqTitle, company: reqCompany,
          }, async (pageTitle, pageDomain) => {
            const prompt = `Extract the specific Job Title and Company Name from this webpage title tag: "${pageTitle}". Return only a raw JSON object with keys "title" and "company". If you cannot determine the company, use "${pageDomain}". Do not use markdown blocks.`;
            const jsonStr = await callGemini(prompt);
            return jsonStr ? JSON.parse(jsonStr.replace(/```json/g, '').replace(/```/g, '').trim()) : {};
          });
          title = metadata.title;
          company = metadata.company;
          location = metadata.location;
          fallbackDesc = metadata.description;
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

    }

    // 2. Resolve Canonical URL & Generate Fingerprint
    const canonicalUrl = await resolveCanonicalUrl({ company, title, url }) || url;
    const fingerprint = generateV4Fingerprint(title, company, location || 'unknown');
    
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
      newJob = await followConsolidation(newJob);
      if (rescoreDuplicate !== true) {
        return NextResponse.json({
          job: newJob,
          isDuplicate: true,
          match: { kind: 'same_link', job: await jobCardSummary(newJob.id), evidence: null },
        });
      }
    } else {
      newJob = await prisma.job.create({
        data: {
          title: title,
          company: company,
          location,
          employer: await resolveEmployerForNewJob({ company, url, canonicalUrl, source: MANUAL_IMPORT_SOURCE }),
          url: url,
          canonicalUrl: canonicalUrl,
          fingerprint: fingerprint,
          description: fallbackDesc, // will be overwritten if scrape succeeds
          source: MANUAL_IMPORT_SOURCE,
          postedAt: new Date(),
          status: MANUAL_IMPORT_INITIAL_LIFECYCLE.status,
          scoringStatus: fallbackDesc.length >= 400 ? 'scored' : 'needs_jd',
          fitScore: 100,
          fitCategory: 'manual',
          experienceStatus: 'queued',
          contextBatched: false,
          tailoringStaged: MANUAL_IMPORT_INITIAL_LIFECYCLE.tailoringStaged,
        }
      });
    }

    // 3. Process immediately by calling the server handlers directly. This
    // avoids a self-fetch whose Host header could otherwise become an SSRF or
    // credential-exfiltration target.
    try {
      const scrapeResponse = await scrapeJob(new Request('https://internal.invalid/api/jobs/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      }), { params: Promise.resolve({ id: newJob.id }) });
      if (!scrapeResponse.ok) {
        console.warn('Manual import follow-up refresh failed; retained the initial posting metadata', {
          jobId: newJob.id, status: scrapeResponse.status,
        });
      }
    } catch (error) {
      console.warn('Manual import follow-up refresh failed; retained the initial posting metadata', {
        jobId: newJob.id, error: error instanceof Error ? error.message : String(error),
      });
    }

    // Local/JD/DeepSeek processing remains in the normal queue. The scrape
    // handler schedules only this job for local scoring, so importing one URL
    // cannot unexpectedly process hundreds of unrelated records.
    const updatedJob = await prisma.job.findUnique({ where: { id: newJob.id } });

    // A different link to a job that is already saved (CoStar's careers page
    // vs. its Workday posting) creates a card before the description can be
    // read. Ask whether it is the same job instead of leaving two cards.
    const likelyMatch = !isDuplicate && updatedJob
      ? await findSameRoleCard(updatedJob).catch((error: unknown) => {
        console.error('Same-role lookup failed for a pasted link:', error);
        return null;
      })
      : null;

    return NextResponse.json({
      job: updatedJob,
      isDuplicate,
      match: likelyMatch ? { kind: 'likely_same_role', job: likelyMatch.job, evidence: likelyMatch.evidence } : null,
    });

  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
