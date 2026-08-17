import { isStructuredAtsSource } from './jobDescriptionQuality';
import { passesPreFilter } from './jobFiltering';
import { localTriageVerdict } from './localTriage';

/**
 * Lane one of local scoring, as a single definition.
 *
 * Local scoring deliberately runs *after* JD recovery: aggregator metadata is
 * often wrong on arrival — a guessed location, or none — and resolving the
 * description is what settles it. Rejecting on geography before that point
 * would discard good roles on bad data.
 *
 * A direct ATS board is different. It publishes the posting's own location,
 * title and company, so the record is authoritative the moment it lands and JD
 * recovery cannot improve it. Those postings can be judged immediately, which
 * matters because the JD-recovery branch returns early: a posting with a thin
 * or empty description otherwise reached no metadata filter at all, burned
 * three rounds of recovery, and landed in Action Needed asking a human to
 * review a London internship that two free checks would have rejected.
 *
 * This lives in one place because two callers must agree exactly: `jobScoring`
 * applies it to new work, and `scripts/triage_stuck_ats_jobs.ts` applies it
 * retroactively to the queue that accumulated before it existed. If they
 * drifted, the script would dismiss rows the pipeline would have kept.
 */

/** Glassdoor's search result carries the same complete, authored tuple. */
const GLASSDOOR_SOURCE = 'Glassdoor (RapidAPI)';

/**
 * Whether a source states its own metadata rather than inferring it.
 *
 * Adzuna, Himalayas and TheMuse deliberately fail this: an aggregator's
 * location is a guess until the description resolves, so they keep lane two.
 */
export function hasAuthoritativeMetadata(source: string | null | undefined): boolean {
  return source === GLASSDOOR_SOURCE || isStructuredAtsSource(source);
}

export type MetadataGateVerdict = {
  /** True when the posting may continue to JD recovery and scoring. */
  passes: boolean;
  /** Empty when it passes. */
  reason: string;
};

const PASSES: MetadataGateVerdict = { passes: true, reason: '' };

/**
 * Both checks are description-independent by construction.
 *
 * `passesPreFilter` rejects on title alone — internship, administrative,
 * clinical, engineering and so on — which is why an empty description is passed
 * to it rather than the stored one. `localTriageVerdict` with an empty
 * `capRationale` evaluates only title geography and the location field, and
 * passes when either is absent: missing metadata is not evidence of a bad
 * location.
 */
export function evaluateAuthoritativeMetadata(job: {
  title: string | null | undefined;
  company: string | null | undefined;
  location: string | null | undefined;
  url?: string | null;
}): MetadataGateVerdict {
  const prefilter = passesPreFilter({
    title: job.title || '',
    company: job.company || '',
    description: '',
    location: job.location || '',
    url: job.url || '',
  });
  if (!prefilter.passes) return { passes: false, reason: prefilter.reason };

  const triage = localTriageVerdict({
    capRationale: '',
    title: job.title,
    location: job.location,
  });
  if (!triage.pass) return { passes: false, reason: `Locally triaged out: ${triage.reason}` };

  return PASSES;
}
