/**
 * Recognizing one job that reached the Dashboard through two sources.
 *
 * ## Why the ingestion identity is not enough
 *
 * Ingestion drops an incoming posting only when it is provably the same record:
 * the same requisition URL, the same source ID, or a byte-identical description
 * under an identically normalized employer, title and location. Aggregators
 * defeat every one of those. Measured on production on 2026-09-25, the copies
 * Joseph kept seeing twice differed only in presentation:
 *
 * - employer: "chrobinson.wd5" / "C.H. Robinson", "ZINC Zillow, Inc." /
 *   "Zillow Group", "Progleasing" / "Progressive Leasing", "U.S. Bank" /
 *   "Elavon, Inc." on the same requisition P-040289;
 * - location: "Remote - US" / "United States", "Eden Prairie, MN" /
 *   "Eden Prairie, MN United States of America";
 * - description: the same text with different line breaks, a publisher footer,
 *   or a few changed characters.
 *
 * ## The test
 *
 * Title and location decide whether two cards *can* be the same opening; the
 * description proves that they are.
 *
 * - Titles must agree after presentation-only cleanup. Titles that differ in a
 *   word are different jobs far more often than not: Esri's "Sr. Partner
 *   Manager - AWS" and "- System Integrators" share 97% of their text, as do
 *   territory postings such as The Emily Program's "- TX" and "- West MN".
 * - Locations must not contradict. Employers reuse one description for every
 *   territory (EquipmentShare Minneapolis and Sioux City share 99% of their
 *   text), so location stays a hard discriminator.
 * - Proof is text: at least 80% of the shorter description's five-word runs
 *   appear in the other. Different requisitions from one employer share their
 *   boilerplate and measured 50-75% (Samsara, Affirm, C.H. Robinson); true
 *   copies measured 80-100%, almost all above 95%.
 * - Without usable text on one side, only an exact employer, title and
 *   location match is accepted, which keeps store-by-store clones such as
 *   Home Depot's apart.
 *
 * Employer names are supporting evidence, not a gate: subsidiaries, reposters
 * and ATS slugs make them unreliable, and the measured cross-employer matches
 * were all the same posting. Two postings from the same employer feed family
 * (two direct ATS rows, or two DEjobs/CareerForce rows) are never paired: the
 * employer itself listed them as separate requisitions.
 */

import { titleLocationSuffix } from './atsDirectMatch';
import {
  descriptionContainment,
  descriptionShingles,
  employerRelation,
  repeatLocationRelation,
  repeatTitleKey,
  singleNamedCity,
  type EmployerRelation,
  type LocationRelation,
  type ShingleCache,
} from './appliedRepeatMatch';
import { normalizeJobLocation } from './jobIngestion';
import { isDejobsSyndicationSource } from './jobSourceProvenance';
import { isWorkdayLocationsPlaceholder } from './workdayLocation';

export const SAME_JOB_TEXT_CONTAINMENT = 0.8;

export type SameJobSubject = {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  source: string | null;
};

export type SameJobEvidence = {
  rule: 'description' | 'identity';
  employer: EmployerRelation | null;
  location: Exclude<LocationRelation, 'conflict'>;
  /** Share of the shorter description found in the other, when both are usable. */
  containment: number | null;
};

// ---------------------------------------------------------------------------
// Title

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', reg: '®', trade: '™',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/**
 * The applied-repeat title key, after undoing what feeds add to a title:
 * HTML entities ("Field Sales &amp; Marketing") and a JSearch "job at
 * <employer>" tail. Seniority, specialty and territory words stay.
 */
export function sameJobTitleKey(title: string | null | undefined): string {
  const cleaned = decodeEntities(String(title || ''))
    .replace(/\s+job\s+at\s+\S.*$/i, '');
  return repeatTitleKey(cleaned);
}

// ---------------------------------------------------------------------------
// Location

/**
 * Workday writes a statewide posting as "All Cities, Minnesota, United States
 * of America"; read as a city named "All Cities" it contradicted every real
 * city in that state.
 */
function withoutAllCities(location: string | null | undefined): string {
  return String(location || '').replace(/\ball cities\s*,\s*/gi, '');
}

/**
 * Unlike an applied repeat, two different specific places never match here,
 * even inside the Twin Cities metro: employers post one text per territory
 * (Acosta's Shakopee and Maple Grove), and Adzuna's "City, County" drops the
 * state, so its "Bloomington" may be Illinois.
 */
export function sameJobLocationRelation(left: string | null | undefined, right: string | null | undefined): LocationRelation {
  return repeatLocationRelation(withoutAllCities(left), withoutAllCities(right), { metroEquivalence: false });
}

function isSpecificLocation(location: string | null | undefined): boolean {
  const value = String(location || '').trim();
  const normalized = normalizeJobLocation(value);
  return Boolean(value)
    && !isWorkdayLocationsPlaceholder(value)
    && !['unknown', 'remote', 'us', 'remote us'].includes(normalized);
}

// ---------------------------------------------------------------------------
// Description

/**
 * Error pages that JD recovery has stored in place of a description. Two
 * unrelated postings recovered through the same blocked proxy would otherwise
 * look like identical text.
 */
const ERROR_PAGE = /\b(?:the request could not be satisfied|target url returned error \d{3}|generated by cloudfront|attention required! \| cloudflare|access denied\b.{0,80}\breference #|403 forbidden|404 not found)\b/i;

export function isUnusableDescription(description: string | null | undefined): boolean {
  return ERROR_PAGE.test(String(description || '').slice(0, 4000));
}

function shinglesFor(subject: SameJobSubject, cache: ShingleCache): Set<string> {
  let shingles = cache.get(subject.id);
  if (!shingles) {
    shingles = isUnusableDescription(subject.description) ? new Set() : descriptionShingles(subject.description);
    cache.set(subject.id, shingles);
  }
  return shingles;
}

// ---------------------------------------------------------------------------
// Sources

/**
 * Which employer feed a row came from, when it came from one. Two rows from
 * the same feed family are separate requisitions by the employer's own
 * account; an ATS row and a DEjobs/CareerForce row can be the same posting.
 */
export function employerFeedFamily(source: string | null | undefined): 'ats' | 'dejobs' | null {
  const value = String(source || '').trim();
  if (/^ATS-/i.test(value)) return 'ats';
  if (isDejobsSyndicationSource(value)) return 'dejobs';
  return null;
}

// ---------------------------------------------------------------------------
// Decision

/** Cheap pre-check that needs no description. */
export function maySameJob(
  left: Pick<SameJobSubject, 'id' | 'title' | 'source'>,
  right: Pick<SameJobSubject, 'id' | 'title' | 'source'>,
): boolean {
  if (left.id === right.id) return false;
  const family = employerFeedFamily(left.source);
  if (family && family === employerFeedFamily(right.source)) return false;
  const title = sameJobTitleKey(left.title);
  return Boolean(title) && title === sameJobTitleKey(right.title);
}

/**
 * Title and text agree, location aside. Used only to tell a missing link
 * between two copies (one says "Minnesota, US", the other "Minneapolis,
 * Hennepin County") from a contradiction.
 */
export function sameJobTextAgrees(
  left: SameJobSubject,
  right: SameJobSubject,
  cache: ShingleCache = new Map(),
): boolean {
  if (!maySameJob(left, right) || differentTitleTerritories(left, right)) return false;
  const containment = descriptionContainment(shinglesFor(left, cache), shinglesFor(right, cache));
  return containment !== null && containment >= SAME_JOB_TEXT_CONTAINMENT;
}

/** The one city this card's location names, if it names exactly one. */
export function sameJobAnchorCity(location: string | null | undefined): string | null {
  return singleNamedCity(withoutAllCities(location));
}

// Both titles named a territory and they differ ("- Fridley, MN" / "-
// Minneapolis, MN"): the title normalizer removed the only difference.
function differentTitleTerritories(left: SameJobSubject, right: SameJobSubject): boolean {
  const leftSuffix = titleLocationSuffix(decodeEntities(String(left.title || '')));
  const rightSuffix = titleLocationSuffix(decodeEntities(String(right.title || '')));
  return Boolean(leftSuffix && rightSuffix && leftSuffix !== rightSuffix);
}

export function judgeSameJob(
  left: SameJobSubject,
  right: SameJobSubject,
  cache: ShingleCache = new Map(),
): SameJobEvidence | null {
  if (!maySameJob(left, right) || differentTitleTerritories(left, right)) return null;

  const location = sameJobLocationRelation(left.location, right.location);
  if (location === 'conflict') return null;
  const employer = employerRelation(left.company, right.company);
  const containment = descriptionContainment(shinglesFor(left, cache), shinglesFor(right, cache));

  if (containment !== null) {
    return containment >= SAME_JOB_TEXT_CONTAINMENT
      ? { rule: 'description', employer, location, containment }
      : null;
  }
  // No usable text on at least one side. Accept only what the display labels
  // prove outright: the same employer, title and specific place.
  if (
    employer === 'same'
    && location === 'equal'
    && isSpecificLocation(left.location)
  ) {
    return { rule: 'identity', employer, location, containment: null };
  }
  return null;
}
