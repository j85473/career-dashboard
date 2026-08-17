import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { identifyAts } from '@/lib/atsUtils';
import { resolveRedirectUrl } from '@/lib/atsRedirect';
import { scrapeAtsApi } from '@/lib/atsApi';
import { scoreJobs } from '@/lib/jobScoring';
import { assertSafeExternalUrl, buildSafeJinaReaderUrl } from '@/lib/safeExternalFetch';
import { invalidateActiveJobScores } from '@/lib/scoreInvalidation';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobScoreAuthority } from '@/lib/scoreAuthority';
import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { randomUUID } from 'node:crypto';

function cleanUrl(url: string) {
  try {
    const parsed = new URL(url);
    // Remove common tracking params
    ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'].forEach(param => {
      parsed.searchParams.delete(param);
    });
    return parsed.toString();
  } catch {
    return url;
  }
}


export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { url, skipRescore, linkOnly } = await request.json();
  
  if (!url) {
    return NextResponse.json({ error: 'URL required' }, { status: 400 });
  }

  try {
    await assertSafeExternalUrl(url);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid URL' }, { status: 400 });
  }

  const resolvedUrl = await resolveRedirectUrl(url);
  try {
    await assertSafeExternalUrl(resolvedUrl);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unsafe redirect target' }, { status: 400 });
  }
  const cleanedUrl = cleanUrl(resolvedUrl);
  const detectedAts = identifyAts({ url: cleanedUrl });

  const existingJob = await prisma.job.findUnique({ where: { id } });
  if (!existingJob) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  if (linkOnly === true) {
    const result = await prisma.job.updateMany({
      where: { id, updatedAt: existingJob.updatedAt },
      data: {
        url: cleanedUrl,
        canonicalUrl: cleanedUrl,
        manualAts: detectedAts || undefined,
      },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: 'Job changed before the link could be updated. Please retry.' }, { status: 409 });
    }
    const updatedJob = await prisma.job.findUnique({ where: { id } });
    const latestScores = await latestJobScoreEvents(updatedJob ? [updatedJob.id] : []);
    const authoritativeJob = updatedJob
      ? projectJobScoreAuthority(updatedJob, latestScores.get(updatedJob.id) || null)
      : null;
    return NextResponse.json({
      job: authoritativeJob,
      rescoreQueued: false,
      scoreInvalidated: false,
      linkOnly: true,
    });
  }

  // A manual scrape supersedes an automated JD lease. The unique token and
  // post-claim updatedAt snapshot prevent an older/concurrent scrape from
  // applying after the user edits or changes the lifecycle decision.
  const scrapeLeaseId = `scrape:${randomUUID()}`;
  const claimed = await prisma.job.updateMany({
    where: { id, updatedAt: existingJob.updatedAt },
    data: {
      jdBatchId: scrapeLeaseId,
      // A manual scrape supersedes both local and DeepSeek work based on the
      // previous URL/description. Clearing their leases makes those workers'
      // guarded writes harmless without letting their cleanup invalidate this
      // scrape's updatedAt snapshot.
      batchJobId: null,
      afBatchId: null,
      ...(existingJob.scoringStatus === 'scoring' ? {
        scoringStatus: ['pending_af', 'inbox'].includes(existingJob.status) ? 'queued' : 'scored',
      } : {}),
    },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: 'Job changed before scraping could start. Please retry.' }, { status: 409 });
  }
  const claimedJob = await prisma.job.findUnique({ where: { id } });
  if (!claimedJob || claimedJob.jdBatchId !== scrapeLeaseId) {
    return NextResponse.json({ error: 'Job scrape lease was superseded. Please retry.' }, { status: 409 });
  }

  try {
    let descriptionText = '';
    let manualAts = detectedAts;
    let foundSlug = '';
    let foundPlatform = '';

    let newTitle: string | undefined = undefined;
    let newCompany: string | undefined = undefined;

    // 1. Try ATS specific API
    const atsResult = await scrapeAtsApi(cleanedUrl);
    
    if (atsResult) {
      descriptionText = atsResult.text;
      manualAts = atsResult.ats;
      foundSlug = atsResult.atsSlug || '';
      foundPlatform = atsResult.platform || '';
      
      if (atsResult.title) newTitle = atsResult.title;
      if (foundSlug) {
        const lowerCompany = (claimedJob.company || '').toLowerCase();
        if (/job-boards|greenhouse\.io|lever\.co|ashbyhq/i.test(lowerCompany)) {
           newCompany = foundSlug.charAt(0).toUpperCase() + foundSlug.slice(1);
        }
      }
    } else {
      // 2. Fallback to Jina API for reliable Markdown extraction (bypasses SPAs/Bots)
      const jinaUrl = await buildSafeJinaReaderUrl(cleanedUrl);
      const res = await fetch(jinaUrl);
      if (!res.ok) throw new Error('Jina Fetch failed');
      
      const markdown = await res.text();
      if (markdown && markdown.length > 500) {
        descriptionText = markdown;
      } else {
        throw new Error('Scraped text is too short, likely bot protection or SPA');
      }
    }

    const changedFields = [
      descriptionText !== claimedJob.description ? 'description' : null,
      newTitle && newTitle !== claimedJob.title ? 'title' : null,
      newCompany && newCompany !== claimedJob.company ? 'company' : null,
    ].filter((field): field is string => field !== null && field !== undefined);
    const rescoreRequestedAt = new Date();

    // The guarded write, score invalidation, and immutable evidence are one
    // atomic decision. A successful scrape can therefore never leave a prior
    // score event authoritative for replacement job inputs.
    const mutation = await prisma.$transaction(async (tx) => {
      const result = await tx.job.updateMany({
        where: {
          id,
          jdBatchId: scrapeLeaseId,
          updatedAt: claimedJob.updatedAt,
          status: claimedJob.status,
          batchJobId: null,
          afBatchId: null,
        },
        data: {
          url: cleanedUrl,
          canonicalUrl: cleanedUrl,
          description: descriptionText,
          manualAts: manualAts || undefined,
          jdBatchId: null,
          ...(newTitle ? { title: newTitle } : {}),
          ...(newCompany ? { company: newCompany } : {}),
          ...(skipRescore ? {} : {
            status: 'pending_af',
            scoringStatus: 'queued',
            experienceStatus: 'queued',
            // A leftover lease makes the job unclaimable by local scoring.
            batchJobId: null,
            scoreAttempts: 0,
            scoreError: null,
            fitScore: null,
            fitCategory: 'unscored',
            fitRationale: null,
            recommendedResume: null,
            aimFitScore: null,
            reqFitScore: null,
            reqFitRationale: null,
            travelScore: null,
            passReason: null,
            afBatchId: null,
            deepseekScoreAttempts: 0,
            deepseekScoreError: null,
          })
        }
      });

      const invalidation = result.count === 1 && (changedFields.length > 0 || !skipRescore)
        ? await invalidateActiveJobScores({
          jobId: id,
          source: claimedJob.source,
          sourceId: claimedJob.sourceId,
          changedFields,
          route: 'manual_scrape',
        }, tx)
        : { invalidatedEventIds: [], staleReason: null };
      if (result.count === 1 && !skipRescore) {
        await recordJobPipelineEvent({
          eventType: 'user_rescore',
          jobId: id,
          stage: 'manual_scoring',
          source: claimedJob.source,
          sourceId: claimedJob.sourceId,
          occurredAt: rescoreRequestedAt,
          identityParts: ['manual_scrape', scrapeLeaseId],
          details: { route: 'manual_scrape', changedFields },
        }, tx);
      }
      return { result, invalidation };
    });
    const updateResult = mutation.result;

    if (updateResult.count === 0) {
      const currentJob = await prisma.job.findUnique({ where: { id } });
      return NextResponse.json({
        error: 'Job changed while scraping; the stale scrape result was discarded.',
        job: currentJob,
      }, { status: 409 });
    }

    // Only learn from ATS metadata after the guarded job write succeeds. A
    // stale scrape must not feed discovery state derived from an obsolete URL.
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
      }).catch((error) => console.error('Failed to record discovered ATS company:', error));
    }

    const updatedJob = await prisma.job.findUnique({ where: { id } });
    const latestScores = await latestJobScoreEvents(updatedJob ? [updatedJob.id] : []);
    const authoritativeJob = updatedJob
      ? projectJobScoreAuthority(updatedJob, latestScores.get(updatedJob.id) || null)
      : null;

    // Fire and forget local scoring since it's fast (only if not skipping rescore)
    if (!skipRescore) {
      try {
        scoreJobs(undefined, undefined, { jobIds: [id], limit: 1 }).catch(e => console.error('Auto-scoring failed:', e));
      } catch {}
    }

    return NextResponse.json({
      job: authoritativeJob,
      rescoreQueued: !skipRescore,
      scoreInvalidated: mutation.invalidation.invalidatedEventIds.length > 0,
    });

  } catch (error: unknown) {
    console.error("Scraping failed:", error);
    await prisma.job.updateMany({
      where: { id, jdBatchId: scrapeLeaseId },
      data: { url: cleanedUrl, canonicalUrl: cleanedUrl },
    });
    const updatedJob = await prisma.job.findUnique({ where: { id } });
    const latestScores = await latestJobScoreEvents(updatedJob ? [updatedJob.id] : []);
    const authoritativeJob = updatedJob
      ? projectJobScoreAuthority(updatedJob, latestScores.get(updatedJob.id) || null)
      : null;
    return NextResponse.json({ 
      error: `Scraping failed: ${error instanceof Error ? error.message : String(error)}`,
      needManual: true,
      job: authoritativeJob,
      scoreInvalidated: false,
    }, { status: 500 });
  } finally {
    await prisma.job.updateMany({
      where: { id, jdBatchId: scrapeLeaseId },
      data: { jdBatchId: null },
    }).catch((error) => console.error('Failed to release scrape lease:', error));
  }
}
