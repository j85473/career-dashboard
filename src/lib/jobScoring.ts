import { prisma } from './prisma';
import { callGemini } from './gemini';
import { getAllResumes } from './resume';
import { identifyAts } from './atsUtils';

export const MIN_JD_LENGTH = 500;
export const MIN_ACCEPTABLE_JD = 400;

async function resolveFullDescription(job: any): Promise<{ text: string, needsReview: boolean }> {
  const description = job.description || '';
  const isEllipsis = description.endsWith('...') || description.endsWith('…');
  const isTruncated = isEllipsis || description.length <= MIN_JD_LENGTH || description === 'No description provided.';
  
  if (!isTruncated || (description.length >= MIN_ACCEPTABLE_JD && !isEllipsis)) {
    return { text: description, needsReview: false };
  }

  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const serpApiKey = process.env.SERPAPI_KEY;

  // Fallback 1: JSearch (RapidAPI)
  if (rapidApiKey) {
    try {
      const jsearchParams = new URLSearchParams({
        query: `${job.company} ${job.title}`,
        page: "1",
        num_pages: "1"
      });
      const jsearchRes = await fetch(`https://jsearch.p.rapidapi.com/search?${jsearchParams.toString()}`, {
        headers: {
          'X-RapidAPI-Key': rapidApiKey,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (jsearchRes.ok) {
        const data = await jsearchRes.json();
        const found = data.data?.[0];
        if (found && found.employer_name?.toLowerCase().includes(job.company.toLowerCase().substring(0, 5))) {
          if (found.job_description && found.job_description.length > description.length + 100) {
            return { text: found.job_description, needsReview: false };
          }
        }
      }
    } catch(e) {}
  }

  // Fallback 2: Canonical Webpage Scraping via SerpApi
  if (serpApiKey) {
    try {
      let canonicalUrl = job.canonicalUrl;
      if (!canonicalUrl || canonicalUrl.includes('adzuna') || canonicalUrl.includes('indeed') || canonicalUrl.includes('jsearch') || canonicalUrl.includes('linkedin')) {
        const serpParams = new URLSearchParams({
          engine: "google",
          q: `${job.company} ${job.title} careers`,
          api_key: serpApiKey,
        });
        const serpRes = await fetch(`https://serpapi.com/search.json?${serpParams.toString()}`, {
          signal: AbortSignal.timeout(10000)
        });
        if (serpRes.ok) {
          const data = await serpRes.json();
          const topLink = data.organic_results?.[0]?.link;
          if (topLink && !topLink.includes('adzuna') && !topLink.includes('indeed') && !topLink.includes('salary.com')) {
            canonicalUrl = topLink;
            await prisma.job.update({ where: { id: job.id }, data: { canonicalUrl } }).catch(()=>{});
          }
        }
      }

      if (canonicalUrl) {
        // First try the specialized ATS API scraper
        const { scrapeAtsApi } = await import('./atsApi');
        const atsResult = await scrapeAtsApi(canonicalUrl);
        if (atsResult && atsResult.text.length > 1000) {
          // If we successfully identified the ATS and scraped it, update the job record
          if (atsResult.ats !== 'Unknown') {
            await prisma.job.update({ where: { id: job.id }, data: { manualAts: atsResult.ats } }).catch(()=>{});
          }
          return { text: atsResult.text, needsReview: false };
        }

        // Fallback to naive fetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let bodyText = '';
        try {
          const pageRes = await fetch(canonicalUrl, { 
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
              return { text: `Original Truncated Snippet:\n${description}\n\nCanonical Webpage Scraped Text:\n${bodyText.substring(0, 15000)}`, needsReview: false };
            }
          }
        } catch (e) {
          clearTimeout(timeoutId);
        }

        // Jina Fallback moved below
      }
    } catch(e) {}
  }

  // Fallback 3: Jina AI Scraper (works with or without SerpAPI and JINA_KEY)
  const targetUrl = job.canonicalUrl || job.url;
  if (targetUrl) {
    const JINA_KEY = process.env.JINA_API_KEY;
    try {
      const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
      if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`;
      
      const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers,
        signal: AbortSignal.timeout(15000)
      });
      if (jinaRes.ok) {
        const markdown = await jinaRes.text();
        if (markdown && markdown.length > 300) {
          return { text: markdown.substring(0, 20000), needsReview: false };
        }
      }
    } catch (e) {
      // Ignore jina errors
    }
  }

  // Fallback 4: Human-in-the-loop
  if (description.length >= MIN_ACCEPTABLE_JD) {
    return { text: description, needsReview: false };
  }
  
  return { text: description, needsReview: true };
}


function runLocalHeuristic(job: any, resumes: any[], preferences: any[]) {
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

  // Extract words from JD (simple tokenizer)
  const jdWords = new Set(combinedText.match(/\b[a-z]{4,}\b/g) || []);
  
  let bestScore = 0;
  let bestResume = resumes.length > 0 ? resumes[0].name : 'Core';

  for (const r of resumes) {
    const resumeWords = new Set(r.text.toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
    let overlap = 0;
    for (const w of Array.from(resumeWords)) {
      if (jdWords.has(w as string)) overlap++;
    }
    // Normalize overlap
    const score = Math.min(100, Math.round((overlap / (jdWords.size || 1)) * 100 * 3.0)); 
    if (score > bestScore) {
      bestScore = score;
      bestResume = r.name;
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
  const ats = identifyAts(job);

  // ATS Rules
  if (ats === 'Workday') {
    bestScore -= 10;
  } else if (ats === 'SuccessFactors') {
    bestScore -= 10;
  } else if (ats === 'Greenhouse' || ats === 'Lever' || ats === 'Ashby') {
    bestScore += 10;
  }

  // Floor it at 40 if not rejected
  if (bestScore < 40) bestScore = 40;

  const finalScore = Math.max(0, Math.min(100, bestScore));

  let category = 'moderate';
  if (finalScore >= 80) category = 'no-tailoring';
  else if (finalScore >= 65) category = 'minor';

  let rationale = `Local Scoring Engine (ATS: ${ats}). Score based on heuristic keyword overlap.`;
  if (ats === 'SuccessFactors') {
    rationale += ` Note: SAP SuccessFactors has a notoriously strict parser. Use a simple, single-column document without complex layouts or tables to avoid silent errors during extraction.`;
  }

  return { score: finalScore, category, recommendedResume: bestResume, rationale };
}

export async function scoreJobs(onProgress?: (msg: string, job?: any) => void, signal?: AbortSignal) {
  const queuedJobs = await prisma.job.findMany({
    where: { 
      scoringStatus: { in: ['queued', 'failed'] },
      scoreAttempts: { lt: 3 },
      status: { notIn: ['dismissed', 'archived', 'passed', 'applied'] }
    },
    take: 200,
    orderBy: { createdAt: 'asc' }
  });

  if (queuedJobs.length === 0) {
    if (onProgress) onProgress("No new jobs to score.");
    return 0;
  }

  let resumes = [];
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
    
    const claimed = await prisma.job.updateMany({
      where: { id: job.id, scoringStatus: { in: ['queued', 'failed'] } },
      data: { scoringStatus: 'scoring' }
    });
    if (claimed.count === 0) continue;

    try {
      const { text: fullDesc, needsReview } = await resolveFullDescription(job);
      if (needsReview) {
        const nextAttempts = job.scoreAttempts + 1;
        const isDead = nextAttempts >= 3;

        const updated = await prisma.job.update({
          where: { id: job.id },
          data: {
            scoringStatus: isDead ? 'failed' : 'needs_jd',
            scoreAttempts: nextAttempts,
            fitCategory: 'review',
            fitScore: null,
            fitRationale: isDead ? 'Failed to fetch JD after 3 attempts. Needs manual review.' : 'Job description was severely truncated. Please submit JD Batch or review manually.'
          }
        });
        if (onProgress) onProgress(isDead ? `Graveyard ${job.company}` : `Needs JD ${job.company}`, updated);
        scoredCount++;
        continue;
      }

      const jobWithFullDesc = { ...job, fullDescription: fullDesc };
      
      const { score, category, recommendedResume, rationale } = runLocalHeuristic(jobWithFullDesc, resumes, preferences);
      
      if (category === 'rejected') {
        const updated = await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'dismissed',
            fitCategory: 'rejected',
            fitRationale: rationale,
            description: fullDesc,
            scoringStatus: 'scored',
            scoreAttempts: { increment: 1 }
          }
        });
        if (onProgress) onProgress(`Scored ${job.company} (Rejected)`, updated);
      } else {
        const updated = await prisma.job.update({
          where: { id: job.id },
          data: {
            fitScore: score,
            fitCategory: category,
            fitRationale: rationale,
            description: fullDesc,
            recommendedResume: recommendedResume,
            tailoringAdvice: null,
            scoringStatus: 'scored',
            scoreAttempts: { increment: 1 }
          }
        });
        if (onProgress) onProgress(`Scored ${job.company} (${score})`, updated);
      }
      scoredCount++;
    } catch (e: any) {
      console.error(`Error scoring:`, e);
      const newAttempts = job.scoreAttempts + 1;
      await prisma.job.update({
        where: { id: job.id },
        data: {
          scoreAttempts: newAttempts,
          scoreError: e.message || 'Unknown error',
          scoringStatus: 'failed'
        }
      });
    }
  }

  return scoredCount;
}
