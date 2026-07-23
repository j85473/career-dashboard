import { prisma } from './prisma';
import { getAllResumes } from './resume';
import type { ResumeData } from './resume';
import { identifyAts } from './atsUtils';
import { passesPreFilter } from './jobFiltering';
import { assertSafeExternalUrl, safeExternalFetch } from './safeExternalFetch';
import { getSerpApiKeys, getRapidApiKeys, fetchWithKeyRotation } from './apiFallback';
import type { Job, UserPreference } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { search, SafeSearchType } from 'duck-duck-scrape';

export const MIN_JD_LENGTH = 500;
export const MIN_ACCEPTABLE_JD = 400;

type ResolvedDescription = {
  text: string;
  needsReview: boolean;
  canonicalUrl?: string;
  manualAts?: string;
  discoveredTitle?: string;
  discoveredCompany?: string;
};

async function resolveFullDescription(job: Job): Promise<ResolvedDescription> {
  const description = job.description || '';
  const isEllipsis = description.endsWith('...') || description.endsWith('…');
  const isTruncated = isEllipsis || description.length <= MIN_JD_LENGTH || description === 'No description provided.';
  
  if (!isTruncated || (description.length >= MIN_ACCEPTABLE_JD && !isEllipsis)) {
    return { text: description, needsReview: false };
  }

  const rapidApiKeys = getRapidApiKeys();
  const serpApiKeys = getSerpApiKeys();
  let resolvedCanonicalUrl = job.canonicalUrl || undefined;
  let discoveredCanonicalUrl: string | undefined;
  let discoveredAts: string | undefined;

  const result = (text: string, needsReview: boolean, extra?: { title?: string, company?: string }): ResolvedDescription => ({
    text,
    needsReview,
    ...(discoveredCanonicalUrl ? { canonicalUrl: discoveredCanonicalUrl } : {}),
    ...(discoveredAts ? { manualAts: discoveredAts } : {}),
    ...(extra?.title ? { discoveredTitle: extra.title } : {}),
    ...(extra?.company ? { discoveredCompany: extra.company } : {}),
  });

  // Fallback 1: JSearch (RapidAPI)
  if (rapidApiKeys.length > 0) {
    try {
      const jsearchParams = new URLSearchParams({
        query: `${job.company} ${job.title}`,
        page: "1",
        num_pages: "1"
      });
      const jsearchRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => fetch(`https://jsearch.p.rapidapi.com/search?${jsearchParams.toString()}`, {
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        },
        signal: AbortSignal.timeout(10000)
      }));
      if (jsearchRes && jsearchRes.ok) {
        const data = await jsearchRes.json();
        const found = data.data?.[0];
        if (found && found.employer_name?.toLowerCase().includes(job.company.toLowerCase().substring(0, 5))) {
          if (found.job_description && found.job_description.length > description.length + 100) {
            return result(found.job_description, false, { title: found.job_title, company: found.employer_name });
          }
        }
      }
    } catch {}
  }

  // Fallback 2: Canonical Webpage Scraping via DuckDuckGo
  try {
    let canonicalUrl = resolvedCanonicalUrl;
    if (!canonicalUrl || canonicalUrl.includes('adzuna') || canonicalUrl.includes('indeed') || canonicalUrl.includes('jsearch') || canonicalUrl.includes('linkedin')) {
      try {
        const ddgQuery = `${job.company} ${job.title} careers`;
        const ddgRes = await search(ddgQuery, { safeSearch: SafeSearchType.STRICT });
        const results = ddgRes.results || [];
        for (const res of results) {
          const url = res.url;
          if (url && !url.includes('adzuna') && !url.includes('indeed') && !url.includes('salary.com')) {
            canonicalUrl = url;
            resolvedCanonicalUrl = canonicalUrl;
            discoveredCanonicalUrl = canonicalUrl;
            break;
          }
        }
      } catch (e) {
        console.error("DuckDuckGo search fallback failed:", e);
      }
    }

    if (canonicalUrl) {
      // First try the specialized ATS API scraper
      const { scrapeAtsApi } = await import('./atsApi');
      const atsResult = await scrapeAtsApi(canonicalUrl);
      if (atsResult && atsResult.text.length > 1000) {
        // If we successfully identified the ATS and scraped it, update the job record
        if (atsResult.ats !== 'Unknown') {
          discoveredAts = atsResult.ats;
        }
        return result(atsResult.text, false, { title: atsResult.title, company: atsResult.atsSlug });
      }

      // Fallback to naive fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let bodyText = '';
      try {
        const pageRes = await safeExternalFetch(canonicalUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (pageRes.ok) {
          const html = await pageRes.text();
          const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
          bodyText = bodyMatch ? bodyMatch[1] : html;
          bodyText = bodyText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                             .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                             .replace(/<[^>]+>/g, ' ')
                             .replace(/\s+/g, ' ')
                             .trim();
          if (bodyText.length > 1000) {
            return result(`Original Truncated Snippet:\n${description}\n\nCanonical Webpage Scraped Text:\n${bodyText.substring(0, 15000)}`, false);
          }
        }
      } catch {
        clearTimeout(timeoutId);
      }

      // Jina Fallback moved below
    }
  } catch {}

  // Fallback 3: Jina AI Scraper (works with or without SerpAPI and JINA_KEY)
  const targetUrl = resolvedCanonicalUrl || job.url;
  if (targetUrl) {
    const JINA_KEY = process.env.JINA_API_KEY;
    try {
      await assertSafeExternalUrl(targetUrl);
      const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
      if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`;
      
      const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers,
        signal: AbortSignal.timeout(15000)
      });
      if (jinaRes.ok) {
        const markdown = await jinaRes.text();
        if (markdown && markdown.length > 300) {
          return result(markdown.substring(0, 20000), false);
        }
      }
    } catch {
      // Ignore jina errors
    }
  }

  // Fallback 4: Human-in-the-loop
  if (description.length >= MIN_ACCEPTABLE_JD) {
    return result(description, false);
  }
  
  return result(description, true);
}


const STOP_WORDS = new Set([
  'about', 'after', 'also', 'been', 'being', 'company', 'from', 'have', 'into',
  'more', 'other', 'role', 'that', 'their', 'there', 'these', 'they', 'this',
  'through', 'using', 'what', 'when', 'where', 'which', 'with', 'will', 'work',
  'years', 'your',
]);

function tokenize(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/\b[a-z][a-z0-9+#.-]{2,}\b/g) || [])
      .map((word) => word.replace(/[.+#-]+$/g, ''))
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

type LocalScoringJob = Pick<Job, 'title' | 'url' | 'source' | 'manualAts'> & { fullDescription: string };

export function runLocalHeuristic(job: LocalScoringJob, resumes: ResumeData[], preferences: UserPreference[]) {
  const titleLower = job.title.toLowerCase();
  const descLower = job.fullDescription.toLowerCase();
  const combinedText = `${titleLower} ${descLower}`;
  
  const getPrefs = (type: string) => preferences.filter(p => p.type === type).map(p => p.text.toLowerCase());
  const hardRejects = getPrefs('hard_reject');
  const boosts = getPrefs('boost');
  const softNegatives = getPrefs('soft_negative');
  
  for (const reject of hardRejects) {
    if (combinedText.includes(reject)) {
      return { score: 0, category: 'rejected', recommendedResume: null, rationale: `Violated hard reject preference: ${reject}` };
    }
  }

  const jdWords = tokenize(combinedText);
  
  let bestScore = 0;
  let bestResume = 'Channel Sales';

  if (resumes.length > 0) {
    for (const resume of resumes) {
      const resumeWords = tokenize(resume.text || '');
      let overlap = 0;
      for (const word of jdWords) {
        if (resumeWords.has(word)) overlap++;
      }
      const coverage = overlap / Math.max(1, Math.min(jdWords.size, 200));
      const score = Math.round(Math.min(100, 25 + coverage * 150));
      if (score > bestScore) {
        bestScore = score;
        bestResume = resume.name;
      }
    }
  }

  // Apply Boosts
  for (const boost of boosts) {
    if (combinedText.includes(boost)) bestScore += 5;
  }

  // Apply Soft Negatives
  for (const neg of softNegatives) {
    if (combinedText.includes(neg)) bestScore -= 5;
  }

  // ATS Identification
  const ats = identifyAts({
    url: job.url || undefined,
    source: job.source || undefined,
    manualAts: job.manualAts,
  });

  // ATS Rules
  if (ats === 'Workday') {
    bestScore -= 10;
  } else if (ats === 'SuccessFactors') {
    bestScore -= 10;
  } else if (ats === 'Greenhouse' || ats === 'Lever' || ats === 'Ashby') {
    bestScore += 10;
  }

  const finalScore = Math.max(0, Math.min(100, bestScore));

  let category = 'low-confidence';
  if (finalScore >= 80) category = 'no-tailoring';
  else if (finalScore >= 60) category = 'minor';

  let rationale = `Local Scoring Engine (ATS: ${ats}). Score based on heuristic keyword overlap.`;
  if (ats === 'SuccessFactors') {
    rationale += ` Note: SAP SuccessFactors has a notoriously strict parser. Use a simple, single-column document without complex layouts or tables to avoid silent errors during extraction.`;
  }

  return { score: finalScore, category, recommendedResume: bestResume, rationale };
}

/** Recompute only the local heuristic fields for one existing job. */
export async function recomputeLocalScore(jobId: string): Promise<Job | null> {
  const [job, resumes, preferences] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    getAllResumes(),
    prisma.userPreference.findMany(),
  ]);
  if (!job || resumes.length === 0) return job;

  const { score, category, recommendedResume, rationale } = runLocalHeuristic({
    title: job.title,
    url: job.url,
    source: job.source,
    manualAts: job.manualAts,
    fullDescription: job.description || '',
  }, resumes, preferences);

  const updated = await prisma.job.updateMany({
    where: { id: job.id },
    data: {
      fitScore: score,
      fitCategory: category,
      fitRationale: rationale,
      recommendedResume,
    },
  });
  if (updated.count === 0) return prisma.job.findUnique({ where: { id: job.id } });
  return prisma.job.findUnique({ where: { id: job.id } });
}

export type ScoreJobsOptions = {
  jobIds?: string[];
  limit?: number;
};

const ACTIVE_SCORING_STATUSES = ['pending_af', 'inbox'];

function claimedJobSnapshot(job: Job, leaseId: string) {
  return {
    id: job.id,
    batchJobId: leaseId,
    scoringStatus: 'scoring',
    status: { in: ACTIVE_SCORING_STATUSES },
    
  };
}

async function releaseLocalScoringLease(jobId: string, leaseId: string) {
  await prisma.$transaction([
    prisma.job.updateMany({
      where: {
        id: jobId,
        batchJobId: leaseId,
        scoringStatus: 'scoring',
        status: { in: ACTIVE_SCORING_STATUSES },
      },
      data: { scoringStatus: 'queued', batchJobId: null },
    }),
    prisma.job.updateMany({
      where: {
        id: jobId,
        batchJobId: leaseId,
        scoringStatus: 'scoring',
        status: { notIn: ACTIVE_SCORING_STATUSES },
      },
      data: { scoringStatus: 'scored', batchJobId: null },
    }),
  ]);
}

export async function scoreJobs(
  onProgress?: (msg: string, job?: Job) => void,
  signal?: AbortSignal,
  options: ScoreJobsOptions = {},
) {
  const requestedIds = options.jobIds ? [...new Set(options.jobIds.filter(Boolean))] : undefined;
  if (requestedIds && requestedIds.length === 0) return 0;
  const limit = Math.max(1, Math.min(options.limit || 200, 200));
  const queuedJobs = await prisma.job.findMany({
    where: { 
      ...(requestedIds ? { id: { in: requestedIds } } : {}),
      scoringStatus: 'queued',
      jdBatchId: null,
      status: { in: ACTIVE_SCORING_STATUSES }
    },
    take: limit,
    orderBy: { createdAt: 'asc' }
  });

  if (queuedJobs.length === 0) {
    if (onProgress) onProgress("No new jobs to score.");
    return 0;
  }

  let resumes: ResumeData[] = [];
  try {
    resumes = await getAllResumes();
    if (resumes.length === 0) {
      console.warn("No resumes found! Aborting scoring to prevent pipeline failure.");
      if (onProgress) onProgress("No resumes found. Aborting scoring.");
      return 0;
    }
  } catch (e) {
    console.error(e);
    if (onProgress) onProgress("Failed to read resumes.");
    return 0;
  }

  const preferences = await prisma.userPreference.findMany();
  let scoredCount = 0;
  
  for (const job of queuedJobs) {
    if (signal?.aborted) break;
    const leaseId = `local:${randomUUID()}`;

    const claimed = await prisma.job.updateMany({
      where: {
        id: job.id,
        scoringStatus: 'queued',
        jdBatchId: null,
        batchJobId: null,
        status: { in: ACTIVE_SCORING_STATUSES },
      },
      data: { scoringStatus: 'scoring', batchJobId: leaseId }
    });
    if (claimed.count === 0) continue;

    let claimedJob: Job | null = null;
    try {
      // Re-read after the atomic claim. This ensures the scorer uses the latest
      // title, description, URL, and ATS selection rather than the stale queue
      // snapshot taken before another request may have edited the job.
      claimedJob = await prisma.job.findUnique({ where: { id: job.id } });
      if (!claimedJob
        || claimedJob.scoringStatus !== 'scoring'
        || claimedJob.batchJobId !== leaseId
        || !ACTIVE_SCORING_STATUSES.includes(claimedJob.status)) {
        await releaseLocalScoringLease(job.id, leaseId);
        continue;
      }

      const resolved = await resolveFullDescription(claimedJob);
      const { text: fullDesc, needsReview } = resolved;
      const currentJob = await prisma.job.findUnique({ where: { id: job.id } });
      if (!currentJob
        || currentJob.scoringStatus !== 'scoring'
        || currentJob.batchJobId !== leaseId
        || !ACTIVE_SCORING_STATUSES.includes(currentJob.status)) {
        await releaseLocalScoringLease(job.id, leaseId);
        continue;
      }

      if (needsReview) {
        const nextAttempts = currentJob.scoreAttempts + 1;
        const isDead = nextAttempts >= 3;

        const updateResult = await prisma.job.updateMany({
          where: claimedJobSnapshot(currentJob, leaseId),
          data: {
            scoringStatus: isDead ? 'failed' : 'needs_jd',
            batchJobId: null,
            scoreAttempts: nextAttempts,
            passReason: isDead ? 'Failed to fetch JD after 3 attempts. Needs manual review.' : 'Job description was severely truncated. Please submit JD Batch or review manually.',
            ...(isDead ? { status: 'dismissed' } : {}),
            fitScore: null,
            fitRationale: null,
            fitCategory: 'unscored'
          }
        });
        if (updateResult.count === 0) {
          await releaseLocalScoringLease(job.id, leaseId);
          continue;
        }
        const updated = onProgress ? await prisma.job.findUnique({ where: { id: job.id } }) : null;
        if (onProgress) onProgress(
          isDead ? `Dismissed ${currentJob.company}` : `Needs JD ${currentJob.company}`,
          updated || undefined,
        );
        scoredCount++;
        continue;
      }

      const jobWithFullDesc = { ...currentJob, fullDescription: fullDesc };
      
      const newTitle = resolved.discoveredTitle || currentJob.title;
      const newCompany = resolved.discoveredCompany || currentJob.company;
      
      const filterResult = passesPreFilter({
        title: newTitle,
        company: newCompany,
        description: fullDesc,
        location: currentJob.location || '',
        url: currentJob.url || ''
      });

      if (!filterResult.passes) {
        await prisma.job.updateMany({
          where: claimedJobSnapshot(currentJob, leaseId),
          data: {
            title: newTitle,
            company: newCompany,
            description: fullDesc,
            ...(resolved.canonicalUrl ? { canonicalUrl: resolved.canonicalUrl } : {}),
            ...(resolved.manualAts ? { manualAts: resolved.manualAts } : {}),
            scoringStatus: 'skipped',
            status: 'dismissed',
            passReason: filterResult.reason,
            batchJobId: null,
            scoreAttempts: 0,
            scoreError: null,
          }
        });
        if (onProgress) onProgress(`Locally filtered ${newCompany}: ${filterResult.reason}`);
        scoredCount++;
        continue;
      }
      
      const { score, category, recommendedResume, rationale } = runLocalHeuristic(jobWithFullDesc, resumes, preferences);
      let deterministicallyRejected = category === 'rejected';
      let passReason = deterministicallyRejected ? `[Local hard reject] ${rationale}` : null;
      
      if (!deterministicallyRejected) {
        if (score < 60) {
          deterministicallyRejected = true;
          passReason = '[Local Triage] Fit score too low.';
        } else if (currentJob.postedAt) {
          const daysOld = (Date.now() - new Date(currentJob.postedAt).getTime()) / (1000 * 60 * 60 * 24);
          if (daysOld > 30 && score < 80) {
            deterministicallyRejected = true;
            passReason = '[Local Triage] Job too old and fit score under 80.';
          }
        }
      }

      const updateResult = await prisma.job.updateMany({
        where: claimedJobSnapshot(currentJob, leaseId),
        data: {
          fitScore: score,
          fitCategory: category,
          fitRationale: rationale,
          description: fullDesc,
          ...(resolved.canonicalUrl ? { canonicalUrl: resolved.canonicalUrl } : {}),
          ...(resolved.manualAts ? { manualAts: resolved.manualAts } : {}),
          recommendedResume,
          scoringStatus: deterministicallyRejected ? 'skipped' : 'scored',
          batchJobId: null,
          ...(deterministicallyRejected ? {
            status: 'dismissed',
            luckyStatus: 'none',
            passReason,
          } : {}),
          scoreAttempts: 0,
          scoreError: null,
          deepseekScoreAttempts: 0,
          deepseekScoreError: null,
          luckyScoreAttempts: 0,
          luckyScoreError: null,
        },
      });
      if (updateResult.count === 0) {
        await releaseLocalScoringLease(job.id, leaseId);
        continue;
      }
      const updated = onProgress ? await prisma.job.findUnique({ where: { id: job.id } }) : null;
      if (onProgress) onProgress(
        deterministicallyRejected
          ? `Locally rejected ${currentJob.company} without an API call`
          : `Locally triaged ${currentJob.company} (${score})`,
        updated || undefined,
      );
      scoredCount++;
    } catch (error: unknown) {
      console.error(`Error scoring:`, error);
      const newAttempts = (claimedJob?.scoreAttempts ?? job.scoreAttempts) + 1;
      const updateResult = await prisma.job.updateMany({
        where: {
          id: job.id,
          batchJobId: leaseId,
          scoringStatus: 'scoring',
          status: { in: ACTIVE_SCORING_STATUSES },
        },
        data: {
          scoreAttempts: newAttempts,
          scoreError: error instanceof Error ? error.message : 'Unknown error',
          scoringStatus: newAttempts >= 3 ? 'failed' : 'queued',
          batchJobId: null,
        }
      });
      if (updateResult.count === 0) {
        await releaseLocalScoringLease(job.id, leaseId);
      }
    }
  }

  return scoredCount;
}
