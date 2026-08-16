import { extractPostedBaseCompensation } from './postedCompensation';
import { extractPostedTravel } from './postedTravel';

/**
 * Facts read literally off an employer's posting.
 *
 * These are display fields, not scoring inputs. Every value here is either
 * something the JD states outright or null — no model, no inference, no
 * derivation from a score. They are computed during Local Triage, which is the
 * point in the pipeline where the description is final and well before any
 * Aim/Experience export.
 */
export interface PostingFacts {
  postedCompensation: string | null;
  postedTravel: string | null;
}

export function derivePostingFacts(description: string | null | undefined): PostingFacts {
  return {
    postedCompensation: extractPostedBaseCompensation(description),
    postedTravel: extractPostedTravel(description),
  };
}

/**
 * Writes a description together with the facts derived from it.
 *
 * Every persistence site should go through this rather than setting
 * `description` directly. The fields are pure functions of the JD, so letting
 * them be written separately is how they drift: a re-scrape that replaced the
 * description would otherwise leave a stale salary attached to a posting that
 * no longer says it. Returning both in one object makes the correct thing the
 * easy thing at the call site.
 */
export function withPostingFacts<T extends Record<string, unknown>>(
  description: string | null,
  rest?: T,
): T & { description: string | null } & PostingFacts {
  return {
    ...(rest || ({} as T)),
    description,
    ...derivePostingFacts(description),
  };
}
