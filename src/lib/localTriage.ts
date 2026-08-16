import {
  hasMinnesotaLocationOption,
  INTERNATIONAL_LOCATION,
  isGeneralRemoteOption,
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
    isMinneapolisMetroOption(option) || isStatewideMinnesotaOption(option));
  if (!hasConcreteLocal && GLOBAL_SCOPE.test(value)) {
    return { pass: false, reason: `Globally scoped rather than US/Minnesota (${value.slice(0, 80)})` };
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
 * so the location gate cannot see it. A named international region in the title
 * is the role's territory, and no Minneapolis-based candidate covers it.
 */
export function titleGeographyVerdict(title: string | null | undefined): LocalTriageVerdict {
  const value = (title || '').trim();
  if (!value) return PASS;
  if (isMinneapolisMetroOption(value) || hasMinnesotaLocationOption(value)) return PASS;
  const match = value.match(INTERNATIONAL_LOCATION);
  if (!match) return PASS;
  return { pass: false, reason: `Title names a non-US territory (${match[0]})` };
}

/**
 * Combined verdict. Title triage runs first because it is the broader signal,
 * so its reason is the one recorded when both would reject.
 */
export function localTriageVerdict(input: {
  capRationale: string;
  title?: string | null;
  location?: string | null;
}): LocalTriageVerdict {
  if (!LOCAL_TRIAGE_ENABLED) return PASS;
  const title = titleTriageVerdict(input.capRationale);
  if (!title.pass) return title;
  const geography = titleGeographyVerdict(input.title);
  if (!geography.pass) return geography;
  return locationTriageVerdict(input.location);
}
