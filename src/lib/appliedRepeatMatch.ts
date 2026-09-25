/**
 * Recognizing a posting that repeats a job Joseph has already applied to.
 *
 * ## Why this is not the stored fingerprint
 *
 * `identityFingerprint` hashes company|title|location after light cleanup, and
 * the same opening is written differently by every source. A Greenhouse board
 * names its employer "veeamsoftware" and says "Remote, United States"; the
 * Himalayas reprint says "Veeam Software" and "United States". The exact hash
 * therefore matched almost nothing: over its whole life it hid six repeats,
 * while about forty-four reached the Inbox between 2026-08-05 and 2026-09-13.
 *
 * The fingerprint keeps its meaning. This module is a separate, looser test
 * used for one decision only — keeping a repeat of an applied job out of the
 * Inbox — and never to merge two records.
 *
 * ## The test
 *
 * Employer and title must agree after presentation-only normalization, and the
 * locations must not contradict. Then one of two proofs is required:
 *
 * - identity: employer, title and location all agree exactly, and the
 *   descriptions (when both are substantial) do not clearly disagree;
 * - description: at least 80% of the shorter description's five-word runs
 *   appear in the other, with both descriptions long enough to mean something.
 *
 * Location stays a hard discriminator. Employers reuse one description for
 * every territory (Gpac, Georgia-Pacific and Merck each posted dozens of
 * identical listings), so text alone would hide a Michigan job because Joseph
 * applied in Minnesota. A national or remote posting never contradicts a US
 * place: Joseph confirmed on 2026-09-13 that a city posting of a role he
 * applied to remotely is the same opening to him.
 *
 * Measured on production before release: 39 of 60 historical close matches
 * caught with no false match; the misses were truncated reprints under the
 * 0.80 threshold. See docs/APPLIED_REPEAT_SUPPRESSION_DESIGN_2026-09-13.md.
 */

import { companyIdentityKey } from './companyIdentity';
import { employerAliasKey } from './employerIdentity';
import { cleanHtmlText, normalizeJobLocation, normalizeTitle } from './jobIngestion';
import { INTERNATIONAL_LOCATION, isMinneapolisMetroOption, splitLocationOptions } from './jobLocationPolicy';
import { isWorkdayLocationsPlaceholder } from './workdayLocation';

export const REPEAT_DESCRIPTION_CONTAINMENT = 0.8;
/** Below this, a description is a stub that would contain-match anything. */
export const REPEAT_MIN_SHINGLES = 150;
/** Identity is refused when two substantial descriptions share less than this. */
export const REPEAT_IDENTITY_VETO_CONTAINMENT = 0.5;
const SHINGLE_WORDS = 5;
const MIN_EMPLOYER_PREFIX = 4;

export type RepeatSubject = {
  id: string;
  title: string | null;
  company: string | null;
  /** The canonical employer (src/lib/employerIdentity.ts), when resolved. */
  employer?: string | null;
  location: string | null;
  description: string | null;
};

export type EmployerRelation = 'same' | 'prefix';
export type LocationRelation = 'equal' | 'compatible' | 'conflict';

export type AppliedRepeatEvidence = {
  rule: 'identity' | 'description';
  employer: EmployerRelation;
  location: Exclude<LocationRelation, 'conflict'>;
  /** Share of the shorter description found in the other, when both are substantial. */
  containment: number | null;
};

// ---------------------------------------------------------------------------
// Employer

const JOINED_SUFFIXES = [
  'operatingllc', 'incorporated', 'corporation', 'company', 'limited', 'corp', 'llc', 'ltd', 'plc', 'inc', 'co',
] as const;

/**
 * Employer key with spacing, ATS board numbering and joined legal suffixes
 * removed: "Veeam Software" and "veeamsoftware", "Sourcegraph" and
 * "sourcegraph91", "RDO Equipment Co." and "RDO Equipment" agree.
 */
export function repeatEmployerKey(company: string | null | undefined): string {
  let key = companyIdentityKey(company).replace(/\s+/g, '').replace(/\d+$/, '');
  for (const suffix of JOINED_SUFFIXES) {
    if (key.endsWith(suffix) && key.length - suffix.length >= MIN_EMPLOYER_PREFIX) {
      key = key.slice(0, -suffix.length);
      break;
    }
  }
  return key;
}

/**
 * `prefix` covers a brand against its longer legal or divisional name
 * ("Paycom" / "Paycom Online", "Safelite" / "Safelite Fulfilment"). It is weak
 * on its own — "Flex" is a prefix of "Flexential" — so it is only accepted with
 * description proof.
 */
export function employerRelation(left: string | null | undefined, right: string | null | undefined): EmployerRelation | null {
  const a = repeatEmployerKey(left);
  const b = repeatEmployerKey(right);
  if (!a || !b) return null;
  if (a === b) return 'same';
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= MIN_EMPLOYER_PREFIX && longer.startsWith(shorter) ? 'prefix' : null;
}

// ---------------------------------------------------------------------------
// Title

/**
 * Removes remote/country tags that sources add or drop ("(REMOTE US)",
 * "(Remote)", "– Remote") and reads Sr. as Senior. Seniority and specialty
 * words stay: Senior Enterprise AM and Enterprise AM are different jobs.
 */
export function repeatTitleKey(title: string | null | undefined): string {
  const withoutRemoteTags = String(title || '')
    .replace(/\((?:[^)]*\b(?:remote|hybrid|us|usa|u\.s\.|united states)\b[^)]*)\)/gi, ' ')
    .replace(/\s[-–—|:]\s*(?:remote|hybrid)(?:\s*[-,:]?\s*(?:us|usa|u\.s\.|united states))?\s*$/i, ' ');
  return normalizeTitle(withoutRemoteTags)
    .replace(/\bsr\b/g, 'senior')
    .replace(/\bmgr\b/g, 'manager')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Location

const STATES: Readonly<Record<string, string>> = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc',
};
const STATE_CODES = new Set(Object.values(STATES));
const STATE_NAME_PATTERN = new RegExp(
  `\\b(${Object.keys(STATES).sort((left, right) => right.length - left.length).join('|')})\\b`,
  'g',
);
const US_MARKER = /\b(?:united states(?: of america)?|u\.?s\.?a\.?|usa|u\.s\.)\b|\bus\b/i;
const BROAD_WORDS = /^(?:anywhere(?: in the world)?|nationwide|distributed|worldwide|americas|north america|unknown(?: location)?|none|n a|not specified|multiple locations?)$/;
/** Adzuna writes "City, X County"; the county name is not a place claim and can collide with a state. */
const COUNTY = /\b[a-z.' ]+ county\b/gi;

type OptionGeo = {
  foreign: boolean;
  broad: boolean;
  states: Set<string>;
  city: string;
  metro: boolean;
};

function isForeignText(text: string): boolean {
  const withoutDomesticNames = text.toLowerCase().replace(/\blittle canada\b/g, ' ');
  return INTERNATIONAL_LOCATION.test(withoutDomesticNames) && !US_MARKER.test(withoutDomesticNames);
}

function optionGeo(option: string): OptionGeo {
  const withoutCounty = option.replace(COUNTY, ' ');
  const lower = withoutCounty.toLowerCase().replace(/[‐‑‒–—―]/g, '-');
  const states = new Set<string>();
  let rest = lower
    .replace(/\b\d{5}(?:-\d{4})?\b/g, ' ')
    .replace(/\b(?:us|usa)[\s-]+([a-z]{2})\b/g, (match, code: string) => {
      if (!STATE_CODES.has(code)) return match;
      states.add(code);
      return ' , ';
    })
    .replace(/\b(?:north|south|latin|central) america\b|\bamericas\b/g, ' ')
    .replace(/\bunited states(?: of america)?\b|\bu\.?s\.?a\.?\b|\bu\.s\.\b|\busa\b|\bamerica\b/g, ' ')
    .replace(/\b(?:statewide|greater|area|metro|office)\b/g, ' ')
    .replace(/\b(?:remote(?:ly)?|home|hybrid|virtual|based|only|work from home|wfh|onsite|on-site)\b/g, ' ')
    .replace(/\s([a-z]{2})\s*$/, (match, code: string) => (STATE_CODES.has(code) ? `, ${code}` : match));
  rest = rest.replace(STATE_NAME_PATTERN, (name: string) => {
    states.add(STATES[name]);
    return ' , ';
  });
  rest = rest.replace(/(^|[,;()\-]\s*)([a-z]{2})(?=\s*(?:$|[,;()\-]))/g, (match, prefix: string, code: string) => {
    if (!STATE_CODES.has(code)) return match;
    states.add(code);
    return `${prefix} `;
  });
  rest = rest.replace(/\bus\b/g, ' ');
  const segments = rest
    .split(/[,;()\-]/)
    .map((segment) => segment.replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((segment) => !BROAD_WORDS.test(segment));
  const city = (segments[0] || '').replace(/\bsaint\b/g, 'st').replace(/\bst\s+/g, 'st ');
  const foreign = isForeignText(withoutCounty);
  return {
    foreign,
    broad: !foreign && !city && states.size === 0,
    states,
    city,
    metro: isMinneapolisMetroOption(withoutCounty),
  };
}

function optionsCompatible(left: OptionGeo, right: OptionGeo, metroEquivalence: boolean): boolean {
  if (left.foreign || right.foreign) return false;
  if (left.broad || right.broad) return true;
  if (metroEquivalence && left.metro && right.metro) return true;
  const statesKnown = left.states.size > 0 && right.states.size > 0;
  if (statesKnown && ![...left.states].some((state) => right.states.has(state))) return false;
  if (left.city && right.city) return left.city === right.city;
  // One side names only a state: compatible only when the states are known to overlap.
  return statesKnown;
}

function isMissingLocation(location: string | null | undefined): boolean {
  const value = String(location || '').trim();
  return !value
    || isWorkdayLocationsPlaceholder(value)
    || splitLocationOptions(value).some((option) => isWorkdayLocationsPlaceholder(option))
    || normalizeJobLocation(value) === 'unknown';
}

/**
 * The one city a location names, or null when it names none (a state, a
 * country, "Remote") or several ("Atlanta, GA; Denver, CO"). A foreign place
 * never counts.
 */
export function singleNamedCity(location: string | null | undefined): string | null {
  const value = String(location || '');
  if (isMissingLocation(value) || isForeignText(value)) return null;
  const options = splitLocationOptions(value);
  const specific = (options.length ? options : [value]).map(optionGeo).filter((geo) => !geo.broad && !geo.foreign);
  return specific.length === 1 && specific[0].city && specific[0].states.size <= 1 ? specific[0].city : null;
}

/**
 * Whether two location strings can describe the same opening.
 *
 * Order matters. Foreign-versus-domestic is decided on the whole string first,
 * so "Buenos Aires, Argentina" is not waved through by an "Unknown Location"
 * on the other side, and "Canada – Remote (ON, AB, BC)" is not split into
 * fragments that look domestic.
 */
export function repeatLocationRelation(
  left: string | null | undefined,
  right: string | null | undefined,
  /**
   * Whether two different Twin Cities metro places count as one. True for
   * applied repeats (Joseph confirmed a metro city is the same opening to him);
   * false when merging two cards, where "Shakopee" and "Maple Grove" postings
   * with the same text are different territories.
   */
  options: { metroEquivalence?: boolean } = {},
): LocationRelation {
  const metroEquivalence = options.metroEquivalence ?? true;
  const a = String(left || '');
  const b = String(right || '');
  if (normalizeJobLocation(a) === normalizeJobLocation(b)) return 'equal';

  const aForeign = isForeignText(a);
  const bForeign = isForeignText(b);
  if (aForeign || bForeign) {
    if (aForeign !== bForeign) return 'conflict';
    const na = normalizeJobLocation(a);
    const nb = normalizeJobLocation(b);
    return na.includes(nb) || nb.includes(na) ? 'compatible' : 'conflict';
  }

  if (isMissingLocation(a) || isMissingLocation(b)) return 'compatible';

  const geos = (value: string) => {
    const options = splitLocationOptions(value);
    const all = (options.length ? options : [value]).map(optionGeo);
    // "Remote/Home Georgia" splits into "Remote" and "Home Georgia"; the bare
    // "Remote" fragment must not make the posting national.
    const specific = all.filter((geo) => !geo.broad && !geo.foreign);
    return specific.length ? specific : all.filter((geo) => !geo.foreign);
  };
  const aGeos = geos(a);
  const bGeos = geos(b);
  if (!aGeos.length || !bGeos.length) return 'conflict';
  return aGeos.some((geo) => bGeos.some((other) => optionsCompatible(geo, other, metroEquivalence))) ? 'compatible' : 'conflict';
}

// ---------------------------------------------------------------------------
// Description

export function descriptionShingles(description: string | null | undefined): Set<string> {
  const words = cleanHtmlText(String(description || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const shingles = new Set<string>();
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index += 1) {
    shingles.add(words.slice(index, index + SHINGLE_WORDS).join(' '));
  }
  return shingles;
}

/** Null when either side is too short for containment to mean anything. */
export function descriptionContainment(left: ReadonlySet<string>, right: ReadonlySet<string>): number | null {
  if (left.size < REPEAT_MIN_SHINGLES || right.size < REPEAT_MIN_SHINGLES) return null;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const shingle of smaller) if (larger.has(shingle)) shared += 1;
  return shared / smaller.size;
}

export type ShingleCache = Map<string, Set<string>>;

function shinglesFor(subject: RepeatSubject, cache: ShingleCache): Set<string> {
  let shingles = cache.get(subject.id);
  if (!shingles) {
    shingles = descriptionShingles(subject.description);
    cache.set(subject.id, shingles);
  }
  return shingles;
}

// ---------------------------------------------------------------------------
// Decision

/**
 * Employer agreement between two cards: the canonical employer when both have
 * one, otherwise the spelling comparison below.
 */
export function subjectEmployerRelation(
  left: Pick<RepeatSubject, 'company' | 'employer'>,
  right: Pick<RepeatSubject, 'company' | 'employer'>,
): EmployerRelation | null {
  if (left.employer && right.employer && employerAliasKey(left.employer) === employerAliasKey(right.employer)) return 'same';
  return employerRelation(left.employer || left.company, right.employer || right.company);
}

/** Cheap pre-check that needs no description: employer and title agree. */
export function mayRepeat(
  candidate: Pick<RepeatSubject, 'title' | 'company' | 'employer'>,
  authority: Pick<RepeatSubject, 'title' | 'company' | 'employer'>,
): boolean {
  const title = repeatTitleKey(candidate.title);
  return Boolean(title)
    && title === repeatTitleKey(authority.title)
    && subjectEmployerRelation(candidate, authority) !== null;
}

export function judgeAppliedRepeat(
  candidate: RepeatSubject,
  authority: RepeatSubject,
  cache: ShingleCache = new Map(),
): AppliedRepeatEvidence | null {
  if (candidate.id === authority.id || !mayRepeat(candidate, authority)) return null;
  const employer = subjectEmployerRelation(candidate, authority)!;
  const location = repeatLocationRelation(candidate.location, authority.location);
  if (location === 'conflict') return null;

  const containment = descriptionContainment(shinglesFor(candidate, cache), shinglesFor(authority, cache));
  if (
    employer === 'same'
    && location === 'equal'
    && !isMissingLocation(candidate.location)
    && !(containment !== null && containment < REPEAT_IDENTITY_VETO_CONTAINMENT)
  ) {
    return { rule: 'identity', employer, location, containment };
  }
  if (containment !== null && containment >= REPEAT_DESCRIPTION_CONTAINMENT) {
    return { rule: 'description', employer, location, containment };
  }
  return null;
}

/**
 * The strongest matching authority: Applied/Interviewing ahead of a Passed
 * "Already applied", then identity ahead of description, then higher overlap.
 */
export function selectAppliedRepeat<T extends RepeatSubject & { status: string }>(
  candidate: RepeatSubject,
  authorities: readonly T[],
  cache: ShingleCache = new Map(),
): { authority: T; evidence: AppliedRepeatEvidence } | null {
  let best: { authority: T; evidence: AppliedRepeatEvidence } | null = null;
  const rank = (entry: { authority: T; evidence: AppliedRepeatEvidence }) => [
    ['applied', 'interviewing'].includes(entry.authority.status) ? 1 : 0,
    entry.evidence.rule === 'identity' ? 1 : 0,
    entry.evidence.containment ?? 0,
  ];
  for (const authority of authorities) {
    const evidence = judgeAppliedRepeat(candidate, authority, cache);
    if (!evidence) continue;
    const entry = { authority, evidence };
    if (!best) { best = entry; continue; }
    const [a1, a2, a3] = rank(entry);
    const [b1, b2, b3] = rank(best);
    if (a1 > b1 || (a1 === b1 && (a2 > b2 || (a2 === b2 && a3 > b3)))) best = entry;
  }
  return best;
}
