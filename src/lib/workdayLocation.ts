/**
 * Recovering the real city Workday encodes in its posting URL, for the rows
 * where `locationsText` is the "<N> Locations" placeholder rather than a
 * real place. See docs/prompts/workday-location-placeholder.md.
 *
 * Fails closed throughout: a wrong city is worse than a known-unknown,
 * because `localTriageVerdict` trusts whatever location it is given.
 */

const US_STATE_ABBREVIATIONS = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
]);

const US_STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota',
  'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
]);

// Workday appends a non-place qualifier to some city segments for facility
// labels, e.g. "Phoenix-Office". Dropping a recognized one is safe; a
// trailing word not on this list is left alone rather than guessed at.
const NON_PLACE_LABELS = new Set([
  'office', 'site', 'location', 'hq', 'headquarters', 'corporate',
  'branch', 'plant', 'facility', 'campus', 'store', 'remote',
]);

/**
 * Matches Workday's placeholder location string for a multi-location
 * requisition ("2 Locations", "51 locations"). Shared with
 * `isUnreliableLocation` in appliedDuplicatePolicy.ts so the two files agree
 * on exactly one definition of "placeholder".
 */
export function isWorkdayLocationsPlaceholder(location: string | null | undefined): boolean {
  return /^\d+\s+locations?$/i.test(String(location || '').trim());
}

function looksLikeStreetAddress(tokens: string[]): boolean {
  return tokens.some((token) => /^\d+(st|nd|rd|th)?$/i.test(token));
}

/** Parses one hyphen-joined field, e.g. "Dallas-TX" or "Phoenix-Office". */
function parseField(field: string): string | null {
  const tokens = field.split('-').filter(Boolean);
  if (tokens.length === 0) return null;
  if (looksLikeStreetAddress(tokens)) return null;

  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && US_STATE_ABBREVIATIONS.has(last)) {
    return `${tokens.slice(0, -1).join(' ')}, ${last}`;
  }
  if (tokens.length > 1 && NON_PLACE_LABELS.has(last.toLowerCase())) {
    return tokens.slice(0, -1).join(' ') || null;
  }
  // Try a full state name as a 1-3 token suffix (longest first, since state
  // names run up to three words), so "Youngstown-Ohio" reads as
  // "Youngstown, Ohio" instead of a bare concatenation — this is the GFS
  // case from the prompt doc, not a hypothetical.
  for (const suffixLen of [3, 2, 1]) {
    if (tokens.length <= suffixLen) continue;
    const suffixTokens = tokens.slice(-suffixLen);
    if (US_STATE_NAMES.has(suffixTokens.join(' ').toLowerCase())) {
      const city = tokens.slice(0, -suffixLen).join(' ');
      return city ? `${city}, ${suffixTokens.join(' ')}` : null;
    }
  }
  // No recognizable state or label suffix — treat the whole field as one
  // plain place name (e.g. "Plainville").
  return tokens.join(' ');
}

/**
 * Parses the `/job/<segment>/` URL segment Workday puts between the tenant
 * and the requisition slug.
 */
export function parseWorkdaySegment(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;

  // Workday separates two distinct location fields with a run of 2+ hyphens
  // ("Virtual---California"); a single hyphen joins words within one field
  // ("Dallas-TX", "Phoenix-Office").
  const parts = trimmed.split(/-{2,}/).filter(Boolean);

  if (parts.length === 1) {
    return parseField(parts[0]);
  }

  if (parts.length === 2) {
    const [first, second] = parts;
    const secondAsName = second.replace(/-/g, ' ').toLowerCase();
    if (US_STATE_NAMES.has(secondAsName)) {
      const firstTokens = first.split('-').filter(Boolean);
      if (firstTokens.length === 0 || looksLikeStreetAddress(firstTokens)) return null;
      return `${firstTokens.join(' ')}, ${second.replace(/-/g, ' ')}`;
    }
    // Two place-shaped fields with nothing to anchor them to a state, e.g.
    // "Champaign---Hazelwood", name two different cities for one
    // requisition. Picking either one would silently claim a single place
    // the posting does not have, so this fails closed rather than guessing.
    return null;
  }

  return null;
}

/**
 * Extracts and parses the city from a Workday `externalPath` such as
 * `/job/Dallas-TX/NERC-P-C-Engineer_JR617`. Returns null when the path has
 * no `/job/<segment>/` shape or the segment can't be read as one place.
 */
export function parseWorkdayLocationFromPath(externalPath: string | null | undefined): string | null {
  if (!externalPath) return null;
  const match = externalPath.match(/\/job\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return parseWorkdaySegment(segment);
}

/**
 * Recovers a real city for the Workday placeholder case only. Returns null
 * (never invents a location) when `locationsText` isn't the placeholder, or
 * when the URL doesn't yield a readable single place — the caller should
 * keep its existing `locationsText` in either case.
 */
export function resolveWorkdayPlaceholderLocation(
  locationsText: string | null | undefined,
  externalPath: string | null | undefined,
): string | null {
  if (!isWorkdayLocationsPlaceholder(locationsText)) return null;
  return parseWorkdayLocationFromPath(externalPath);
}
