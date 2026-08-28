import { passesPreFilter } from './jobFiltering';

export const TEAMTAILOR_LOCATION_UNAVAILABLE_REASON =
  'Authoritative Teamtailor location unavailable; held outside scoring until location recovery.';

export type TeamtailorLocationAvailability = {
  required: boolean;
  passes: boolean;
  location: string | null;
  reason: string;
};

/**
 * Teamtailor's list feed has no location. A title that can never survive the
 * free prefilter needs no detail request; every title survivor must carry a
 * location recovered from its posting page before it can enter scoring.
 *
 * Missing metadata is normally allowed by the shared geography gate, but it
 * is not an innocent omission for this adapter: it proves the required detail
 * enrichment did not complete. Hold that posting outside scoring so a circuit
 * or endpoint failure can never be reinterpreted as geographic eligibility.
 */
export function evaluateTeamtailorLocationAvailability(input: {
  title: string | null | undefined;
  company: string | null | undefined;
  location: string | null | undefined;
}): TeamtailorLocationAvailability {
  const titlePasses = passesPreFilter({
    title: String(input.title || ''),
    company: String(input.company || ''),
    location: '',
    description: '',
    url: '',
  }).passes;
  const location = String(input.location || '').trim() || null;

  if (!titlePasses) {
    return { required: false, passes: true, location, reason: '' };
  }
  if (location) {
    return { required: true, passes: true, location, reason: '' };
  }
  return {
    required: true,
    passes: false,
    location: null,
    reason: TEAMTAILOR_LOCATION_UNAVAILABLE_REASON,
  };
}
