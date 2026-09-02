import { NextResponse } from 'next/server';
import { JobUrlConflict, lockJobUrlEdits, reconcileJobUrlEdit } from '@/lib/jobUrlReconciliation';
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
import { generateV4Fingerprint } from '@/lib/jobIngestion';
import { preferredJdSourceUrl } from '@/lib/jobSourceProvenance';
import { randomUUID } from 'node:crypto';
import {
  automatedLifecycleIsProtected,
  normalizeManualImportMetadata,
} from '@/lib/manualImportPolicy';
import {
  discoveredAtsBoardFromJobUrl,
  discoveredAtsBoardUpsert,
} from '@/lib/atsBoardDiscovery';

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

  let existingJob = await prisma.job.findUnique({
    where: { id },
    include: {
      observations: {
        select: { source: true, url: true },
      },
    },
  });
  if (!existingJob) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  const discoveredBoardFromUrl = discoveredAtsBoardFromJobUrl(cleanedUrl, detectedAts);

  const submittedStoredUrl = [existingJob.url, existingJob.canonicalUrl]
    .some((storedUrl) => storedUrl && cleanUrl(storedUrl) === cleanUrl(url));
  // Reconcile before any scraping, score invalidation, or lease claim. Both
  // choices in the URL dialog therefore honor an existing application.
  try {
    const snapshot = existingJob;
    const reconciliation = await prisma.$transaction(async (tx) => {
      await lockJobUrlEdits(tx);
      const result = await reconcileJobUrlEdit(tx, {
        id, url: cleanedUrl, expectedUpdatedAt: snapshot.updatedAt,
      });
      if (!result.consolidatedJobId && detectedAts) {
        result.job = await tx.job.update({ where: { id }, data: { manualAts: detectedAts } });
      }
      if (discoveredBoardFromUrl) await tx.atsCompany.upsert(discoveredAtsBoardUpsert(discoveredBoardFromUrl));
      return result;
    });
    if (linkOnly === true || reconciliation.consolidatedJobId) {
      const latestScores = await latestJobScoreEvents([reconciliation.job.id]);
      return NextResponse.json({
        job: projectJobScoreAuthority(reconciliation.job, latestScores.get(reconciliation.job.id) || null),
        consolidatedJobId: reconciliation.consolidatedJobId,
        rescoreQueued: false, scoreInvalidated: false, linkOnly: true,
      });
    }
    existingJob = { ...reconciliation.job, observations: snapshot.observations };
  } catch (error) {
    if (error instanceof JobUrlConflict) return NextResponse.json({ error: error.message, code: 'url_duplicate_conflict' }, { status: 409 });
    console.error('Failed to reconcile job URL:', error);
    return NextResponse.json({ error: 'The link could not be updated. Please retry.' }, { status: 409 });
  }

  const extractionUrl = submittedStoredUrl
    ? preferredJdSourceUrl({
        source: existingJob.source,
        jobUrl: cleanedUrl,
        observations: existingJob.observations,
      }) || cleanedUrl
    : cleanedUrl;
  try {
    await assertSafeExternalUrl(extractionUrl);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid source URL' }, { status: 400 });
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
    let foundSlug = discoveredBoardFromUrl?.slug || '';
    let foundPlatform = discoveredBoardFromUrl?.platform || '';

    let newTitle: string | undefined = undefined;
    let newCompany: string | undefined = undefined;
    let newLocation: string | undefined = undefined;

    // 1. Try ATS specific API
    const atsResult = await scrapeAtsApi(extractionUrl);

    if (atsResult) {
      if (atsResult.text) descriptionText = atsResult.text;
      manualAts = atsResult.ats;
      foundSlug = atsResult.atsSlug || '';
      foundPlatform = atsResult.platform || '';

      if (atsResult.title) newTitle = atsResult.title;
      // Workday's detail response carries the authoritative primary plus
      // additional-location list. Keep it even when the description itself is
      // unusable and recovery falls through to Jina, matching batch-jd-submit —
      // otherwise a manual rescrape fixes the company and leaves the row stuck
      // on the "<N> Locations" placeholder.
      if (atsResult.location) newLocation = atsResult.location;
      if (atsResult.company) {
        newCompany = atsResult.company;
      } else if (foundSlug) {
        const lowerCompany = (claimedJob.company || '').toLowerCase();
        if (/job-boards|greenhouse\.io|lever\.co|ashbyhq/i.test(lowerCompany)) {
           newCompany = foundSlug.charAt(0).toUpperCase() + foundSlug.slice(1);
        }
      }
    }
    if (!atsResult?.text) {
      // 2. Fallback to Jina API for reliable Markdown extraction (bypasses SPAs/Bots)
      const jinaUrl = await buildSafeJinaReaderUrl(extractionUrl);
      const res = await fetch(jinaUrl);
      if (!res.ok) throw new Error('Jina Fetch failed');
      
      const markdown = await res.text();
      if (markdown && markdown.length > 500) {
        descriptionText = markdown;
      } else {
        throw new Error('Scraped text is too short, likely bot protection or SPA');
      }
    }

    const normalizedManualMetadata = normalizeManualImportMetadata({
      source: claimedJob.source,
      title: newTitle || claimedJob.title,
      company: newCompany || claimedJob.company,
      location: newLocation || claimedJob.location,
      description: descriptionText,
      url: cleanedUrl,
    });
    if (normalizedManualMetadata.title !== claimedJob.title) {
      newTitle = normalizedManualMetadata.title;
    }
    if (normalizedManualMetadata.company !== claimedJob.company) {
      newCompany = normalizedManualMetadata.company;
    }
    if (normalizedManualMetadata.location && normalizedManualMetadata.location !== claimedJob.location) {
      newLocation = normalizedManualMetadata.location;
    }

    const changedFields = [
      descriptionText !== claimedJob.description ? 'description' : null,
      newTitle && newTitle !== claimedJob.title ? 'title' : null,
      newCompany && newCompany !== claimedJob.company ? 'company' : null,
      newLocation && newLocation !== claimedJob.location ? 'location' : null,
    ].filter((field): field is string => field !== null && field !== undefined);
    const resolvedTitle = newTitle || claimedJob.title;
    const resolvedCompany = newCompany || claimedJob.company;
    const resolvedLocation = newLocation || claimedJob.location || 'Unknown Location';
    const scoringIdentityChanged = resolvedTitle !== claimedJob.title
      || resolvedCompany !== claimedJob.company
      || resolvedLocation !== claimedJob.location;
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
          ...(newLocation ? { location: newLocation } : {}),
          ...(scoringIdentityChanged ? {
            identityFingerprint: generateV4Fingerprint(
              resolvedTitle,
              resolvedCompany,
              resolvedLocation,
            ),
          } : {}),
          ...(skipRescore ? {} : {
            status: automatedLifecycleIsProtected(claimedJob) ? claimedJob.status : 'pending_af',
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
      await prisma.atsCompany.upsert(discoveredAtsBoardUpsert({
        slug: foundSlug,
        platform: foundPlatform,
      })).catch((error) => console.error('Failed to record discovered ATS company:', error));
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
