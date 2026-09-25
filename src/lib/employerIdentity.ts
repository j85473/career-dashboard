/**
 * One employer, one name.
 *
 * ## The problem this replaces
 *
 * ATS boards and paid searches write the same employer differently: board
 * slugs ("arcticwolf", "spscommerce"), Workday hostnames used when a posting
 * names no employer ("hp.wd5"), Workday legal-entity codes ("2100 NVIDIA USA"),
 * casing and legal suffixes ("HP Inc.", "Hp"), and brand variants that only
 * evidence can join ("Progleasing" / "Progressive Leasing"). Measured on
 * 2026-09-25: 680 employers appeared under two or more names on cards that
 * matter. Every feature that asked "same company?" (cooldown, the company page,
 * the applied-repeat check, display) normalized in its own way, with its own
 * hand-kept alias list, and learned nothing from what the pipeline saw.
 *
 * ## The model
 *
 * `Job.company` stays exactly what the source wrote. It is a scoring input, and
 * the scoring import rejects a batch whose company changed after export, so it
 * is never rewritten here. `Job.employer` holds the canonical employer name,
 * derived from `company` (and the posting's employer site) by `resolveEmployer`
 * on arrival and on every pass, so an edit or re-scrape is picked up by itself.
 *
 * Every "same employer?" question goes through `employerIdentityKey`, which
 * reads `employer` and falls back to the raw company for rows that have none.
 * A contract test fails if another module starts comparing employers itself.
 *
 * Names resolve through `CompanyNameRule`:
 * - Joseph's corrections (origin `manual`) always win;
 * - links the learner derived from evidence (origin `learned`,
 *   `employerLearning.ts`), replaced wholesale on every learning pass;
 * - otherwise the source label, made presentable.
 */

import { companyIdentityKey, GENERIC_EMPLOYER_WORDS, withoutEntityCode } from './companyIdentity';
import { COMPANY_EMPLOYER_URL_RULE, employerUrlKey } from './employerUrl';
import { companyDisplayName } from './companyPresentation';

export const EMPLOYER_NAME_RULE = 'employer';
/**
 * Joseph's correction of one exact spelling. Outranks everything, so two
 * businesses whose names clean up alike ("Flex" / "The Flex Company") can
 * still be told apart.
 */
export const EMPLOYER_LABEL_RULE = 'label';
export const MANUAL_RULE_ORIGIN = 'manual';
export const LEARNED_RULE_ORIGIN = 'learned';
/** Legacy manual rules keyed by `companyIdentityKey` (before 2026-09-25). */
const LEGACY_ALIAS_RULE = 'alias';

const LEGAL_WORDS = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'lp', 'llp', 'plc', 'pllc', 'gmbh', 'operating',
]);
const JOINED_LEGAL = ['incorporated', 'corporation', 'operating', 'company', 'corp', 'llc', 'ltd', 'inc'] as const;
const WORKDAY_LABEL = /^([a-z0-9][a-z0-9-]*)\.wd\d+(?:\.myworkday(?:jobs|site)\.com)?(?:::.*)?$/i;

// ---------------------------------------------------------------------------
// Keys

/**
 * The source label with infrastructure removed: a Workday hostname becomes its
 * tenant, and a legal-entity code is dropped when a real name remains.
 */
export function employerLabel(raw: string | null | undefined): string {
  const value = decodeEntities(String(raw || '')).trim().replace(/\s+/g, ' ');
  const workday = value.match(WORKDAY_LABEL);
  return workday ? workday[1].toLowerCase() : withoutEntityCode(value);
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|apos|nbsp|#39);/gi, (_, name: string) => ENTITIES[name.toLowerCase()] ?? _);
}

/** The exact spelling, for a label rule: entities decoded, case and spacing ignored. */
export function employerLabelKey(raw: string | null | undefined): string {
  return decodeEntities(String(raw || '')).trim().replace(/\s+/g, ' ').toLowerCase();
}

function words(label: string): string[] {
  return label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    // Dotted initials are one word: "L.P.", "U.S.", "C.H." Robinson.
    .replace(/\b([a-z])\.([a-z])\b\.?/g, '$1$2')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function nameWords(label: string): string[] {
  const list = words(label);
  if (list.length > 1 && list[0] === 'the') list.shift();
  while (list.length > 1 && LEGAL_WORDS.has(list.at(-1)!)) list.pop();
  return list;
}

/** An ATS board slug: one lowercase token, as boards and Workday tenants write it. */
function isSlug(label: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(label) && /[a-z]/.test(label);
}

/**
 * Formatting-free identity of a label: case, punctuation, spacing, a leading
 * "The", legal suffixes (spaced or joined to a slug), entity codes, Workday
 * hosts and a slug's board number all fall away. "SPS Commerce, Inc.",
 * "spscommerce.wd108" and "Spscommerce" share one key; "Arctic Wolf" and
 * "Arctic Wolf Networks" do not, since only evidence can join those.
 */
export function employerAliasKey(raw: string | null | undefined): string {
  const label = employerLabel(raw);
  let compact = nameWords(label).join('');
  if (isSlug(label)) {
    if (/[a-z]\d+$/.test(compact)) compact = compact.replace(/\d+$/, '');
    // Stacked suffixes peel one at a time: "sharkninjaoperatingllc".
    for (let peeled = true; peeled;) {
      peeled = false;
      for (const suffix of JOINED_LEGAL) {
        if (compact.endsWith(suffix) && compact.length - suffix.length >= 4) {
          compact = compact.slice(0, -suffix.length);
          peeled = true;
          break;
        }
      }
    }
  }
  return compact;
}

// ---------------------------------------------------------------------------
// How two names relate

/**
 * - `strong`: the names plainly belong together once evidence says so
 *   ("Arctic Wolf" / "Arctic Wolf Networks", "Progleasing" / "Progressive
 *   Leasing", "gomotive" / "Motive", "ZINC Zillow" / "Zillow Group");
 * - `short`: they share only a two- or three-letter name ("HP" / "HP
 *   Development Company", "GE" / "GE HealthCare"), which needs more evidence;
 * - null: unrelated ("U.S. Bank" / "Elavon", "CareMore Health" / "Castlight
 *   Health"), which no evidence can join.
 */
export type NameRelation = 'same' | 'strong' | 'short';

function distinctiveWords(label: string): string[] {
  return nameWords(label).filter((word) => word.length >= 2 && !GENERIC_EMPLOYER_WORDS.has(word) && !LEGAL_WORDS.has(word) && /[a-z]/.test(word));
}

/** "progleasing" read as leading pieces of "progressive leasing". */
function abbreviates(compact: string, tokens: readonly string[]): boolean {
  const walk = (at: number, token: number): boolean => {
    if (at === compact.length) return token >= 2;
    if (token >= tokens.length) return false;
    const word = tokens[token];
    for (let size = Math.min(word.length, compact.length - at); size >= (token === 0 ? 3 : 2); size -= 1) {
      if (word.startsWith(compact.slice(at, at + size)) && walk(at + size, token + 1)) return true;
    }
    return false;
  };
  return compact.length >= 6 && tokens.length >= 2 && walk(0, 0);
}

function initials(tokens: readonly string[]): string {
  return tokens.map((token) => token[0]).join('');
}

export function employerNameRelation(left: string | null | undefined, right: string | null | undefined): NameRelation | null {
  const a = employerLabel(left);
  const b = employerLabel(right);
  const keyA = employerAliasKey(a);
  const keyB = employerAliasKey(b);
  if (!keyA || !keyB) return null;
  if (keyA === keyB) return 'same';
  const [shortKey, longKey, shortLabel, longLabel] = keyA.length <= keyB.length ? [keyA, keyB, a, b] : [keyB, keyA, b, a];
  const longWords = nameWords(longLabel);
  const shortDistinct = distinctiveWords(shortLabel);
  const longDistinct = distinctiveWords(longLabel);

  if (shortKey.length >= 4 && longKey.startsWith(shortKey)) return 'strong';
  // A slug that prefixes the brand: "thedutchie", "gomotive", "joinsurefire".
  if (isSlug(longLabel) && shortKey.length >= 4 && longKey.endsWith(shortKey) && longKey.length - shortKey.length <= 4) return 'strong';
  if (abbreviates(shortKey, longWords)) return 'strong';
  // A shared distinctive word that leads at least one name. Generic words
  // ("health", "networks") never count: CareMore Health is not Castlight Health.
  const leading = new Set([shortDistinct[0], longDistinct[0]].filter(Boolean));
  const sharedLeading = shortDistinct.filter((word) => longDistinct.includes(word) && leading.has(word));
  if (sharedLeading.some((word) => word.length >= 4)) return 'strong';
  // A short name the longer one only extends with legal-entity filler:
  // "HP" / "HP Development Company, L.P.". "GE" / "GE HealthCare" adds a
  // real name and stays weak.
  const entityOnly = (shared: string) => longDistinct.every((word) => word === shared || ENTITY_FILLER.has(word));
  if (sharedLeading.length > 0) return sharedLeading.some(entityOnly) ? 'strong' : 'short';
  if (shortKey.length <= 3 && (longWords.includes(shortKey) || longKey.startsWith(shortKey))) {
    return longWords[0] === shortKey && entityOnly(shortKey) ? 'strong' : 'short';
  }
  if (/^[a-z]{2,5}$/.test(shortKey) && longDistinct.length >= 2 && initials(longDistinct) === shortKey) return 'short';
  return null;
}

/** Words a legal entity adds to a brand without naming anything new. */
const ENTITY_FILLER = new Set(['development', 'dba']);

// ---------------------------------------------------------------------------
// Resolution

export type EmployerRule = {
  matchType: string;
  matchKey: string;
  standardName: string;
  origin: string;
};

export type EmployerRuleIndex = {
  manualByLabel: Map<string, string>;
  manualByKey: Map<string, string>;
  manualByLegacyKey: Map<string, string>;
  manualByUrl: Map<string, string>;
  learnedByKey: Map<string, string>;
  learnedByUrl: Map<string, string>;
};

export function buildEmployerRuleIndex(rules: readonly EmployerRule[]): EmployerRuleIndex {
  const index: EmployerRuleIndex = {
    manualByLabel: new Map(), manualByKey: new Map(), manualByLegacyKey: new Map(), manualByUrl: new Map(),
    learnedByKey: new Map(), learnedByUrl: new Map(),
  };
  for (const rule of rules) {
    const manual = rule.origin !== LEARNED_RULE_ORIGIN;
    if (rule.matchType === EMPLOYER_LABEL_RULE) { if (manual) index.manualByLabel.set(rule.matchKey, rule.standardName); }
    else if (rule.matchType === EMPLOYER_NAME_RULE) (manual ? index.manualByKey : index.learnedByKey).set(rule.matchKey, rule.standardName);
    else if (rule.matchType === COMPANY_EMPLOYER_URL_RULE) (manual ? index.manualByUrl : index.learnedByUrl).set(rule.matchKey, rule.standardName);
    else if (rule.matchType === LEGACY_ALIAS_RULE && manual) {
      index.manualByLegacyKey.set(rule.matchKey, rule.standardName);
      // A legacy key is companyIdentityKey output, a spaced form of the same name.
      const key = employerAliasKey(rule.matchKey);
      if (key && !index.manualByKey.has(key)) index.manualByKey.set(key, rule.standardName);
    }
  }
  return index;
}

export type EmployerSubject = {
  company: string | null | undefined;
  url?: string | null;
  canonicalUrl?: string | null;
  source?: string | null;
};

/** The presentable form of a label when no rule speaks for it. */
export function presentableEmployerName(company: string | null | undefined, source?: string | null): string {
  const label = decodeEntities(String(company || '')).trim().replace(/\s+/g, ' ');
  if (!label) return '';
  const workday = label.match(WORKDAY_LABEL);
  const named = workday ? workday[1].split(/[-_]+/).map((part) => (/^\d+[a-z]+$/i.test(part)
    ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))).join(' ') : withoutEntityCode(label);
  return companyDisplayName(named, source ?? null) || named;
}

function urlKeysOf(subject: EmployerSubject): string[] {
  return [...new Set([subject.canonicalUrl, subject.url].map(employerUrlKey).filter((key): key is string => Boolean(key)))];
}

/**
 * The canonical employer for a card. A learned site rule only applies to a
 * label that plausibly names that employer, so a subsidiary posting on its
 * parent's Workday tenant ("Timberland" on VF's) keeps its own name.
 */
export function resolveEmployer(subject: EmployerSubject, index: EmployerRuleIndex): string {
  const label = String(subject.company || '').trim();
  const key = employerAliasKey(label);
  const urls = urlKeysOf(subject);
  const manual = index.manualByLabel.get(employerLabelKey(label))
    || (key && index.manualByKey.get(key))
    || index.manualByLegacyKey.get(companyIdentityKey(label))
    || urls.map((url) => index.manualByUrl.get(url)).find(Boolean);
  if (manual) return manual;
  const learned = key ? index.learnedByKey.get(key) : undefined;
  if (learned) return learned;
  const bySite = urls.map((url) => index.learnedByUrl.get(url)).find((name) => name && employerNameRelation(label, name));
  if (bySite) return bySite;
  return presentableEmployerName(label, subject.source) || label || 'Unknown Company';
}

// ---------------------------------------------------------------------------
// The one comparison

/**
 * The key every "same employer?" question compares. Reads the canonical
 * employer, and the raw company only for rows the resolver has not reached.
 */
export function employerIdentityKey(job: { employer?: string | null; company?: string | null; source?: string | null }): string {
  return employerAliasKey(job.employer || presentableEmployerName(job.company, job.source));
}

export function sameEmployer(
  left: { employer?: string | null; company?: string | null; source?: string | null },
  right: { employer?: string | null; company?: string | null; source?: string | null },
): boolean {
  const key = employerIdentityKey(left);
  return key.length > 0 && key === employerIdentityKey(right);
}

/** The name to show for a card's employer. */
export function employerDisplayName(job: { employer?: string | null; company?: string | null; source?: string | null }): string {
  return job.employer || presentableEmployerName(job.company, job.source) || String(job.company || '');
}
