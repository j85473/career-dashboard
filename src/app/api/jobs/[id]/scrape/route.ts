import { NextResponse } from 'next/server';
import { JobUrlConflict, lockJobUrlEdits, reconcileJobUrlEdit } from '@/lib/jobUrlReconciliation';
import { prisma } from '@/lib/prisma';
import { identifyAts } from '@/lib/atsUtils';
import { resolveRedirectUrl } from '@/lib/atsRedirect';
import { adzunaDetailsUrl, extractAdzunaPostingText } from '@/lib/adzunaDetails';
import { scrapeAtsApi, scrapeJobPostingMetadata } from '@/lib/atsApi';
import { completePostingMetadata, parsePostingReaderMetadata, postingMetadataValue, postingRefreshDescription } from '@/lib/postingMetadata';
import { scoreJobs } from '@/lib/jobScoring';
import { assertSafeExternalUrl, buildSafeJinaReaderUrl } from '@/lib/safeExternalFetch';
import { invalidateActiveJobScores } from '@/lib/scoreInvalidation';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { projectJobScoreAuthority } from '@/lib/scoreAuthority';
import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { generateV4Fingerprint } from '@/lib/jobIngestion';
import { preferredJdSourceUrl } from '@/lib/jobSourceProvenance';
import { assessJobDescriptionQuality } from '@/lib/jobDescriptionQuality';
import { parseGustoReaderMarkdown } from '@/lib/gustoBoard';
import { randomUUID } from 'node:crypto';
import {
  automatedLifecycleIsProtected,
  normalizeManualImportMetadata,
} from '@/lib/manualImportPolicy';
import {
  discoveredAtsBoardFromJobUrl,
  recordDiscoveredAtsBoard,
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
  const preserveScores = linkOnly === true || skipRescore === true;
  
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
  // Before deciding that a user-entered URL conflicts with a saved listing,
  // ask its direct ATS/API adapter for the authored identity. Aggregators often
  // abbreviate a legal employer name or describe a city as its county. This is
  // comparison-only: no job fields or scores change unless the normal scrape
  // path continues after reconciliation.
  const directAtsResult = await scrapeAtsApi(cleanedUrl).catch((error) => {
    console.warn('Direct ATS identity lookup failed during URL reconciliation:', error);
    return null;
  });
  const directPostingResult = await completePostingMetadata(directAtsResult, () => scrapeJobPostingMetadata(cleanedUrl));
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
        // A pasted link that belongs to another card always opens the focused
        // two-card review. Detection itself never chooses a survivor.
        allowConsolidation: false,
        directMetadata: directPostingResult ? {
          title: directPostingResult.title,
          company: directPostingResult.company,
          location: directPostingResult.location,
        } : undefined,
      });
      if (detectedAts !== 'Unknown' && result.job.manualAts !== detectedAts) {
        result.job = await tx.job.update({
          where: { id: result.job.id },
          data: { manualAts: detectedAts },
        });
      }
      if (discoveredBoardFromUrl) await recordDiscoveredAtsBoard(tx, discoveredBoardFromUrl);
      return result;
    });
    if (reconciliation.consolidatedJobId) {
      const latestScores = await latestJobScoreEvents([reconciliation.job.id]);
      return NextResponse.json({
        job: projectJobScoreAuthority(reconciliation.job, latestScores.get(reconciliation.job.id) || null),
        consolidatedJobId: reconciliation.consolidatedJobId,
        rescoreQueued: false, scoreInvalidated: false, linkOnly: true,
      });
    }
    existingJob = { ...reconciliation.job, observations: snapshot.observations };
  } catch (error) {
    if (error instanceof JobUrlConflict) return NextResponse.json({ error: error.message, code: 'url_duplicate_conflict', mergeTargetJobId: error.mergeTargetJobId }, { status: 409 });
    console.error('Failed to reconcile job URL:', error);
    return NextResponse.json({ error: 'The link could not be updated. Please retry.' }, { status: 409 });
  }

  // Re-fetching a stored Adzuna link reads its `/details/` page: the `/land/ad/`
  // link returns a bot wall that is long enough to be saved as a description.
  const adzunaDetails = submittedStoredUrl
    ? adzunaDetailsUrl({ source: existingJob.source, sourceId: existingJob.sourceId, url: cleanedUrl })
    : null;
  const extractionUrl = adzunaDetails || (submittedStoredUrl && detectedAts === 'Unknown'
    ? preferredJdSourceUrl({
        source: existingJob.source,
        jobUrl: cleanedUrl,
        observations: existingJob.observations,
      }) || cleanedUrl
    : cleanedUrl);
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
    const atsResult = extractionUrl === cleanedUrl
      ? directPostingResult
      : await completePostingMetadata(await scrapeAtsApi(extractionUrl), () => scrapeJobPostingMetadata(extractionUrl));
    let structuredDescription = false;

    if (atsResult) {
      if (atsResult.text && assessJobDescriptionQuality(atsResult.text, { structuredSource: true }).scorable) {
        descriptionText = atsResult.text;
        structuredDescription = true;
      }
      if (atsResult.ats !== 'Unknown') manualAts = atsResult.ats;
      foundSlug = atsResult.atsSlug || '';
      foundPlatform = atsResult.platform || '';

      newTitle = postingMetadataValue(atsResult.title);
      // Workday's detail response carries the authoritative primary plus
      // additional-location list. Keep it even when the description itself is
      // unusable and recovery falls through to Jina, matching batch-jd-submit —
      // otherwise a manual rescrape fixes the company and leaves the row stuck
      // on the "<N> Locations" placeholder.
      newLocation = postingMetadataValue(atsResult.location);
      newCompany = postingMetadataValue(atsResult.company);
    }
    if (!descriptionText || !newCompany || !newLocation) {
      // The reader can fill missing metadata even when the API already supplied
      // a complete description. Preserve API evidence if this optional read fails.
      try {
        const jinaUrl = await buildSafeJinaReaderUrl(extractionUrl);
        const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
        if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
        const res = await fetch(jinaUrl, { headers, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error('Jina Fetch failed');
        const rawMarkdown = await res.text();
        const readerMetadata = parsePostingReaderMetadata(rawMarkdown, extractionUrl);
        newTitle ||= readerMetadata.title;
        newCompany ||= readerMetadata.company;
        newLocation ||= readerMetadata.location;
        const markdown = adzunaDetails ? extractAdzunaPostingText(rawMarkdown) : rawMarkdown;
        const gustoPosting = detectedAts === 'Gusto' ? parseGustoReaderMarkdown(markdown, extractionUrl) : null;
        if (gustoPosting) {
          newTitle ||= gustoPosting.title;
          newCompany ||= gustoPosting.company;
        }
        if (!descriptionText) {
          if (gustoPosting) descriptionText = gustoPosting.description;
          else if (markdown && markdown.length > 500) descriptionText = markdown;
          else throw new Error('Scraped text is too short, likely bot protection or SPA');
        }
      } catch (error) {
        if (!descriptionText && !(preserveScores && (newTitle || newCompany || newLocation))) throw error;
        console.warn('Optional posting metadata recovery failed:', error);
      }
    }
    // A blocked/incomplete JD must not prevent verified company and location
    // from refreshing. Keep the saved description and report the missing field.
    const descriptionResult = postingRefreshDescription({
      description: descriptionText,
      structuredSource: structuredDescription,
      existingDescription: claimedJob.description,
      preserveScores,
      metadata: { title: newTitle, company: newCompany, location: newLocation },
    });
    descriptionText = descriptionResult.description;

    const normalizedManualMetadata = normalizeManualImportMetadata({
      source: claimedJob.source,
      title: newTitle || claimedJob.title,
      company: newCompany || claimedJob.company,
      location: newLocation || claimedJob.location,
      // A retained old JD is not evidence about the newly pasted posting.
      description: descriptionResult.verified ? descriptionText : '',
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
      newCompany && (newCompany !== claimedJob.company || newCompany !== claimedJob.employer) ? 'company' : null,
      newLocation && newLocation !== claimedJob.location ? 'location' : null,
    ].filter((field): field is string => field !== null && field !== undefined);
    const resolvedTitle = newTitle || claimedJob.title;
    const resolvedCompany = newCompany || claimedJob.company;
    const resolvedLocation = newLocation || claimedJob.location || 'Unknown Location';
    const scoringIdentityChanged = resolvedTitle !== claimedJob.title
      || resolvedCompany !== claimedJob.company
      || resolvedLocation !== claimedJob.location;
    const rescoreRequestedAt = new Date();

    // The guarded write and any explicitly requested rescore are atomic.
    // Keeping scores preserves their authority when posting details change.
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
          ...(newCompany ? { employer: newCompany } : {}),
          ...(newLocation ? { location: newLocation } : {}),
          ...(scoringIdentityChanged ? {
            identityFingerprint: generateV4Fingerprint(
              resolvedTitle,
              resolvedCompany,
              resolvedLocation,
            ),
          } : {}),
          ...(preserveScores ? {} : {
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

      const invalidation = result.count === 1 && !preserveScores
        ? await invalidateActiveJobScores({
          jobId: id,
          source: claimedJob.source,
          sourceId: claimedJob.sourceId,
          changedFields,
          route: 'manual_scrape',
        }, tx)
        : { invalidatedEventIds: [], staleReason: null };
      if (result.count === 1 && !preserveScores) {
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
      await prisma.$transaction((tx) => recordDiscoveredAtsBoard(tx, {
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
    if (!preserveScores) {
      try {
        scoreJobs(undefined, undefined, { jobIds: [id], limit: 1 }).catch(e => console.error('Auto-scoring failed:', e));
      } catch {}
    }

    return NextResponse.json({
      job: authoritativeJob,
      rescoreQueued: !preserveScores,
      scoreInvalidated: mutation.invalidation.invalidatedEventIds.length > 0,
      linkOnly: linkOnly === true,
      refreshedFields: changedFields,
      unverifiedFields: [!newCompany ? 'company' : null, !newLocation ? 'location' : null, !descriptionResult.verified ? 'job description' : null].filter(Boolean),
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
      ...(linkOnly === true
        ? { refreshWarning: `Link saved, but the posting details could not be refreshed: ${error instanceof Error ? error.message : String(error)}` }
        : { error: `Scraping failed: ${error instanceof Error ? error.message : String(error)}`, needManual: true }),
      job: authoritativeJob,
      scoreInvalidated: false,
      linkOnly: linkOnly === true,
    }, { status: linkOnly === true ? 200 : 500 });
  } finally {
    await prisma.job.updateMany({
      where: { id, jdBatchId: scrapeLeaseId },
      data: { jdBatchId: null },
    }).catch((error) => console.error('Failed to release scrape lease:', error));
  }
}
