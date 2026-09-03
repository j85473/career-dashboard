import {
  containsNonlocalGeography,
  hasMinnesotaLocationOption,
  isExplicitInternationalLocationOption,
  isGeneralRemoteOption,
  isLocalMinnesotaOption,
  isMinneapolisMetroOption,
  isStatewideMinnesotaOption,
  isUnknownOrBroadUSOption,
  splitLocationOptions,
} from './jobLocationPolicy';

/**
 * Local triage: the cheap, deterministic gate that runs before the Aim and
 * Experience stages.
 *
 * Aim and Experience are the paid AI evaluation. They exist to make careful
 * judgements about roles that are plausibly in scope — not to sift 26,000
 * postings, 87% of which the local heuristic has already identified as having
 * no target title signal at all. The heuristic used to compute that verdict and
 * then discard it (`gatePass` was hardcoded true, and its caller hardcoded
 * `deterministicallyRejected = false`), so a Food Services Attendant and a Data
 * Centre Remote Hands Engineer both queued for AI review.
 *
 * This gate only withholds. It never promotes, never assigns a fit score, and
 * never overrides a human decision — Aim still owns preference hard stops and
 * Experience still owns qualification for everything that reaches them.
 */

/** Set LOCAL_TRIAGE_ENABLED=false to route everything to Aim again. */
export const LOCAL_TRIAGE_ENABLED = process.env.LOCAL_TRIAGE_ENABLED !== 'false';

export type LocalTriageVerdict = {
  /** True when the job may continue to manual Aim review. */
  pass: boolean;
  reason: string;
};

const PASS: LocalTriageVerdict = {
  pass: true,
  reason: 'discovery metadata only; routed to manual Aim review',
};

/**
 * Employers Joseph has explicitly ruled out, including the labels emitted by
 * their public Workday board. These are exact normalized aliases, rather than
 * a broad "2020" match, so unrelated employers with a year in their name are
 * never swept in.
 */
const EXCLUDED_EMPLOYER_ALIASES = new Map<string, string>([
  ['2020 companies', '2020 Companies'],
  ['2020 companies, inc.', '2020 Companies'],
  ['2020companies.wd1', '2020 Companies'],
]);

function normalizedEmployerName(company: string | null | undefined): string {
  return String(company || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A user-selected employer exclusion; it withholds but never promotes a job. */
export function employerTriageVerdict(company: string | null | undefined): LocalTriageVerdict {
  if (!LOCAL_TRIAGE_ENABLED) return PASS;
  const excludedEmployer = EXCLUDED_EMPLOYER_ALIASES.get(normalizedEmployerName(company));
  return excludedEmployer
    ? { pass: false, reason: `Employer excluded from local scoring (${excludedEmployer})` }
    : PASS;
}

/**
 * The heuristic caps a score below triage when the role has no target sales,
 * account management, partnerships or customer success title signal, or when it
 * is saturated with hunter/operations motion. That capping decision is already
 * deterministic; this simply stops throwing it away.
 */
export function titleTriageVerdict(capRationale: string): LocalTriageVerdict {
  return capRationale ? { pass: false, reason: capRationale } : PASS;
}

/**
 * Geography the search lanes never asked for.
 *
 * A location option survives only if it is Minneapolis metro, statewide
 * Minnesota, general remote, or unknown/broad US. Anything explicitly somewhere
 * else — Austin, London, Bengaluru — is out of scope no matter how good the
 * title is. Provider metadata is the input here, so this is the same evidence
 * Aim would have used, applied earlier and for free.
 *
 * An empty location is deliberately allowed through: absent metadata is not
 * evidence of a bad location, and the JD may still place the role correctly.
 *
 * A posting is withheld only when *every* option is out of scope. Multi-site
 * listings are common — "Austin, TX; Eau Claire, WI; Minneapolis, MN" is one
 * real example — and rejecting on any single out-of-scope option would discard
 * roles that are genuinely available in the Twin Cities. `jobLocationPolicy`'s
 * `containsSpecificNonlocalMetadata` answers the opposite question (does any
 * option look non-local), which suits Aim's flagging but not a hard gate.
 */
export function acceptableLocationOption(option: string): boolean {
  return isMinneapolisMetroOption(option)
    || isStatewideMinnesotaOption(option)
    // Any other in-state location that is not outstate. The metro list above
    // cannot be complete, and every gap silently dismissed a Minnesota job.
    || isLocalMinnesotaOption(option)
    || isUnknownOrBroadUSOption(option)
    || isGeneralRemoteOption(option);
}

/**
 * Explicitly global scope. "Remote / Anywhere in the World" splits into
 * ["Remote", "Anywhere in the World"], and the bare "Remote" fragment would
 * otherwise carry the whole posting through the any-option rule below.
 */
const GLOBAL_SCOPE = /\b(?:anywhere in the world|worldwide|world[- ]?wide|globally|any country|anywhere on earth)\b/i;

export function locationTriageVerdict(location: string | null | undefined): LocalTriageVerdict {
  const value = (location || '').trim();
  if (!value) return PASS;
  const options = splitLocationOptions(value);
  if (options.length === 0) return PASS;
  // A concrete in-scope option still wins — a genuinely global-remote role that
  // also lists Minneapolis is fine.
  const hasConcreteLocal = options.some((option) =>
    isMinneapolisMetroOption(option)
    || isStatewideMinnesotaOption(option)
    || isLocalMinnesotaOption(option));
  if (!hasConcreteLocal && GLOBAL_SCOPE.test(value)) {
    return { pass: false, reason: `Globally scoped rather than US/Minnesota (${value.slice(0, 80)})` };
  }
  // A bare "Remote" or Workday's "N Locations" placeholder cannot rescue an
  // explicitly foreign site. They carry no US evidence. A concrete Minnesota
  // option (handled above) or an explicit US-wide option still legitimately
  // keeps a multi-country requisition in scope.
  const hasExplicitInternational = options.some(isExplicitInternationalLocationOption);
  const hasExplicitUSScope = options.some((option) => (
    isGeneralRemoteOption(option) && /\b(?:u\.?s\.?a?|united[- ]states)\b/i.test(option)
  ) || /^(?:u\.?s\.?a?|united states(?: of america)?)$/i.test(option.trim()));
  if (!hasConcreteLocal && hasExplicitInternational && !hasExplicitUSScope) {
    return { pass: false, reason: `Location outside the searched geographies (${value.slice(0, 80)})` };
  }
  if (options.some(acceptableLocationOption)) return PASS;
  return {
    pass: false,
    reason: `Location outside the searched geographies (${value.slice(0, 80)})`,
  };
}

/**
 * Geography stated in the title rather than the location field.
 *
 * "Senior Partner Solutions Engineer - APAC" arrives with location "Remote",
 * so the location gate cannot see it. A named territory in the title is the
 * role's territory, and no Minneapolis-based candidate covers it — whether
 * that territory is international (APAC) or a named non-Minnesota domestic
 * one (Raleigh, NC). A Workday posting can carry an unresolved "N Locations"
 * placeholder in its location field while its title names the real place;
 * checking only INTERNATIONAL_LOCATION here let those through, so this uses
 * the same broader geography check the location field itself is measured
 * against.
 */
export function titleGeographyVerdict(title: string | null | undefined): LocalTriageVerdict {
  const value = (title || '').trim();
  if (!value) return PASS;
  if (isMinneapolisMetroOption(value) || hasMinnesotaLocationOption(value)) return PASS;
  if (!containsNonlocalGeography(value)) return PASS;
  return { pass: false, reason: `Title names a non-local territory (${value})` };
}

/**
 * Combined verdict. An explicit employer preference runs first; title triage
 * then remains ahead of geography, so its reason is recorded when both reject.
 */
export function localTriageVerdict(input: {
  capRationale: string;
  company?: string | null;
  title?: string | null;
  location?: string | null;
}): LocalTriageVerdict {
  if (!LOCAL_TRIAGE_ENABLED) return PASS;
  const employer = employerTriageVerdict(input.company);
  if (!employer.pass) return employer;
  const title = titleTriageVerdict(input.capRationale);
  if (!title.pass) return title;
  const geography = titleGeographyVerdict(input.title);
  if (!geography.pass) return geography;
  return locationTriageVerdict(input.location);
}
