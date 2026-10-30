import {
  boardIdentityFromUrl,
  resolveDirectAtsPosting,
  type DirectAtsMatch,
  type DirectMatchDeps,
} from './atsDirectMatch';
import {
  verifyJobPosting,
  type JobPostingLiveness,
  type PostingProbe,
} from './jobPostingVerification';
import { authoritativeJobVerificationUrl } from './verifyJobsAlive';

type Candidate = {
  title: string;
  company: string;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
  source?: string | null;
};

export type PreAimPostingVerification = {
  liveness: JobPostingLiveness;
  authority: 'employer_posting' | 'source_copy' | 'unresolved_aggregator';
  sourceLiveness: JobPostingLiveness | null;
  replacement: DirectAtsMatch | null;
  probes: PostingProbe[];
};

type Dependencies = {
  store: DirectMatchDeps['store'];
  verify?: typeof verifyJobPosting;
  resolveCanonical?: typeof resolveDirectAtsPosting;
  fetcher?: DirectMatchDeps['fetcher'];
};

function directPostingUrl(job: Candidate): string | null {
  for (const value of [job.canonicalUrl, job.url]) {
    if (value && boardIdentityFromUrl(value)) return value;
  }
  return null;
}

/**
 * Verifies a locally accepted JSearch job before Aim can spend a model run.
 *
 * A copied aggregator page is useful closure evidence when it is gone, but it
 * is never authoritative proof that the employer's requisition remains open.
 * A uniquely matched employer posting is therefore preferred even when the
 * source copy still renders. Uncertainty stays fail-open.
 */
export async function verifyJSearchBeforeAim(
  job: Candidate,
  dependencies: Dependencies,
): Promise<PreAimPostingVerification> {
  const verify = dependencies.verify || verifyJobPosting;
  const resolveCanonical = dependencies.resolveCanonical || resolveDirectAtsPosting;
  const directUrl = directPostingUrl(job);

  if (directUrl) {
    const employer = await verify(
      { url: directUrl, title: job.title },
      authoritativeJobVerificationUrl(directUrl),
    );
    return {
      liveness: employer.liveness,
      authority: 'employer_posting',
      sourceLiveness: null,
      replacement: employer.liveness === 'alive' && directUrl !== job.url ? {
        url: directUrl,
        description: null,
        platform: boardIdentityFromUrl(directUrl)?.platform || 'unknown',
        slug: boardIdentityFromUrl(directUrl)?.slug || '',
        matchedVia: 'stored',
        matchedBy: 'title',
        postingTitle: job.title,
        postingLocation: job.location || null,
      } : null,
      probes: employer.probes,
    };
  }

  try {
    const replacement = await resolveCanonical(job, {
      store: dependencies.store,
      allowLivePing: true,
      ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    });
    if (replacement && replacement.url !== job.url) {
      const employer = await verify(
        { url: replacement.url, title: replacement.postingTitle || job.title },
        authoritativeJobVerificationUrl(replacement.url),
      );
      return {
        liveness: employer.liveness,
        authority: 'employer_posting',
        sourceLiveness: null,
        replacement: employer.liveness === 'alive' ? replacement : null,
        probes: employer.probes,
      };
    }
  } catch {
    // An unavailable employer catalogue or board cannot justify expiring the
    // copied listing, even if that listing has also disappeared.
    return {
      liveness: 'inconclusive',
      authority: 'unresolved_aggregator',
      sourceLiveness: null,
      replacement: null,
      probes: [],
    };
  }

  if (!job.url) {
    return {
      liveness: 'inconclusive',
      authority: 'unresolved_aggregator',
      sourceLiveness: null,
      replacement: null,
      probes: [],
    };
  }

  const source = await verify(
    { url: job.url, title: job.title },
    authoritativeJobVerificationUrl(job.url),
  );
  const confirmedClosed = source.liveness === 'expired';
  return {
    // A live copied page can outlive the employer requisition. It is recorded
    // as source evidence, but only a closed copy is decisive without a unique
    // employer match.
    liveness: confirmedClosed ? 'expired' : 'inconclusive',
    authority: confirmedClosed ? 'source_copy' : 'unresolved_aggregator',
    sourceLiveness: source.liveness,
    replacement: null,
    probes: source.probes,
  };
}
