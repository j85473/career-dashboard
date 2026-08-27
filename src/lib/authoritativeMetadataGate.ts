import { isStructuredAtsSource } from './jobDescriptionQuality';
import { passesPreFilter } from './jobFiltering';
import { localTriageVerdict } from './localTriage';
import { splitLocationOptions } from './jobLocationPolicy';
import { isCleanUSCityStateShape, isWorkdayLocationsPlaceholder, parseWorkdayLocationFromPath } from './workdayLocation';

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
 * This lives in one place because three callers must agree exactly:
 * `jobScoring` applies it to new work, `batch-jd-submit`'s route applies it
 * before spending a recovery fetch on a posting whose metadata already
 * disqualifies it, and `scripts/triage_stuck_ats_jobs.ts` applies it
 * retroactively to the queue that accumulated before it existed. If they
 * drifted, either the recovery route would burn a paid call the pipeline
 * would have skipped, or the script would dismiss rows the pipeline would
 * have kept.
 */

/** Glassdoor's search result carries the same complete, authored tuple. */
const GLASSDOOR_SOURCE = 'Glassdoor (RapidAPI)';

/**
 * CareerForce and DEjobs read company and location directly off their search
 * cards, not from an inferred field, so — like Glassdoor and the ATS boards —
 * there is nothing for JD recovery to correct. CareerForce was confirmed
 * against 232 stuck rows. DEjobs is held to the same authored-card boundary:
 * its explicit location is authoritative for local triage even though its
 * empty list-view description still requires recovery from the preserved
 * source listing. External scraper source names are matched case-insensitively.
 *
 * Adding another source to this list needs the same bar: evidence that its
 * location is stated on arrival, not guessed, checked against real stuck rows
 * before flipping the switch.
 */
const AUTHORITATIVE_EXTERNAL_SOURCES = new Set(['careerforce', 'dejobs']);

/**
 * Whether a source states its own metadata rather than inferring it.
 *
 * Adzuna, Himalayas, TheMuse, Indeed and RemoteOK deliberately fail this: their
 * location can be inferred or normalized by the provider rather than stated
 * on an authored source card, so they keep lane two.
 */
export function hasAuthoritativeMetadata(source: string | null | undefined): boolean {
  if (typeof source === 'string' && AUTHORITATIVE_EXTERNAL_SOURCES.has(source.trim().toLowerCase())) return true;
  return source === GLASSDOOR_SOURCE || isStructuredAtsSource(source);
}

export type MetadataGateVerdict = {
  /** True when the posting may continue to JD recovery and scoring. */
  passes: boolean;
  /** Empty when it passes. */
  reason: string;
};

const PASSES: MetadataGateVerdict = { passes: true, reason: '' };

export function authoritativeLocationForTriage(job: {
  location: string | null | undefined;
  url?: string | null;
}): string | null {
  const location = String(job.location || '').trim();
  const hasWorkdayPlaceholder = splitLocationOptions(location)
    .some(isWorkdayLocationsPlaceholder);
  if (!hasWorkdayPlaceholder) return location || null;

  const urlLocation = parseWorkdayLocationFromPath(job.url);
  if (!urlLocation) return location || null;
  // A recovered fragment that isn't a confirmed "City, State" shape carries
  // no US evidence at all — exactly what a foreign posting's segment reduces
  // to (e.g. "TH-Pathumthani-Non-Plant" parses to "TH Pathumthani Non", with
  // no US state anywhere in it). Keeping the bare "N Locations" placeholder
  // alongside a fragment like that would let `isUnknownOrBroadUSOption` pass
  // the whole option list on the placeholder's say-so alone — which is
  // exactly how a Thailand posting reached scoring (job 652565cc): neither
  // "TH" nor "Pathumthani" is in the international name/code lists, so
  // nothing flagged it, and the placeholder alone was enough to pass.
  // Enumerating every country a Workday tenant might post from is a losing,
  // ever-incomplete list; dropping the placeholder once there is *any*
  // unconfirmed fragment instead makes "confirmed US" the thing that has to
  // be demonstrated, so an unrecognized country is held for review by
  // default instead of silently passing through an unrelated gap.
  if (!isCleanUSCityStateShape(urlLocation)) return urlLocation;
  return location ? `${location}; ${urlLocation}` : urlLocation;
}

export function evaluateAuthoritativeGeography(job: {
  title: string | null | undefined;
  location: string | null | undefined;
  url?: string | null;
}): MetadataGateVerdict {
  const triage = localTriageVerdict({
    capRationale: '',
    title: job.title,
    location: authoritativeLocationForTriage(job),
  });
  return triage.pass
    ? PASSES
    : { passes: false, reason: `Locally triaged out: ${triage.reason}` };
}

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

  return evaluateAuthoritativeGeography(job);
}
