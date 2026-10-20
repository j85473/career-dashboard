import { hasIncompleteLocations, US_STATE_LOCATION_PATTERN } from './postingLocation';
import {
  containsNonlocalGeography,
  hasMinnesotaLocationOption,
  hasMinneapolisMetroOption,
  hasAssignedTerritoryResidencyRequirement,
  hasRegularPresenceRequirement,
  hasResidencyRequirement,
  isExplicitInternationalLocationOption,
  isGeneralRemoteOption,
  isLocalMinnesotaOption,
  isMinneapolisMetroOption,
  isStatewideMinnesotaOption,
  isUnknownOrBroadUSOption,
  normalizeLocationOption,
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

/** Set LOCAL_TRIAGE_ENABLED=false to disable role and geography triage. */
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
 * their public ATS boards. These are exact normalized aliases, rather than
 * a broad "2020" match, so unrelated employers with a year in their name are
 * never swept in.
 */
const EXCLUDED_EMPLOYER_ALIASES = new Map<string, string>([
  // Goodwill affiliate and ATS employer labels observed in saved jobs.
  // Exact aliases avoid excluding unrelated employers mentioning Goodwill.
  ['abilene goodwill industries', 'Goodwill'],
  ['easter seals goodwill nd', 'Goodwill'],
  ['easter seals goodwill nd inc', 'Goodwill'],
  ['easterseals-goodwill northern rocky mountain inc.', 'Goodwill'],
  ['evansville goodwill industries', 'Goodwill'],
  ['evansville goodwill industries, inc.', 'Goodwill'],
  ['evergreen goodwill', 'Goodwill'],
  ['goodwill', 'Goodwill'],
  ['goodwill brand', 'Goodwill'],
  ['goodwill columbus', 'Goodwill'],
  ['goodwill easterseals miami valley', 'Goodwill'],
  ['goodwill education initiatives, inc.', 'Goodwill'],
  ['goodwill greater milwaukee & chicago', 'Goodwill'],
  ['goodwill ind of the chesapeake', 'Goodwill'],
  ['goodwill ind of the chesapeake inc', 'Goodwill'],
  ['goodwill industries - suncoast', 'Goodwill'],
  ['goodwill industries - suncoast inc', 'Goodwill'],
  ['goodwill industries group', 'Goodwill'],
  ['goodwill industries international', 'Goodwill'],
  ['goodwill industries international, inc.', 'Goodwill'],
  ['goodwill industries manasota', 'Goodwill'],
  ['goodwill industries manasota inc', 'Goodwill'],
  ['goodwill industries of central texas', 'Goodwill'],
  ['goodwill industries of dallas', 'Goodwill'],
  ['goodwill industries of dallas, inc.', 'Goodwill'],
  ['goodwill industries of erie huron ottawa and sandusky counties', 'Goodwill'],
  ['goodwill industries of erie huron ottawa and sandusky counties inc', 'Goodwill'],
  ['goodwill industries of greater new york', 'Goodwill'],
  ['goodwill industries of hawaii', 'Goodwill'],
  ['goodwill industries of houston', 'Goodwill'],
  ['goodwill industries of kentucky', 'Goodwill'],
  ['goodwill industries of middle tennessee', 'Goodwill'],
  ['goodwill industries of northeast texas', 'Goodwill'],
  ['goodwill industries of northeast texas inc', 'Goodwill'],
  ['goodwill industries of northern wi and upper mi', 'Goodwill'],
  ['goodwill industries of orange county ca', 'Goodwill'],
  ['goodwill industries of south mississippi', 'Goodwill'],
  ['goodwill industries of southeastern wisconsin', 'Goodwill'],
  ['goodwill industries of southeastern wisconsin, inc.', 'Goodwill'],
  ['goodwill industries of southern arizona', 'Goodwill'],
  ['goodwill industries of the southern piedmont', 'Goodwill'],
  ['goodwill industries of the southern piedmont, inc.', 'Goodwill'],
  ['goodwill industries of the southern rivers', 'Goodwill'],
  ['goodwill industries of tulsa', 'Goodwill'],
  ['goodwill industries of tulsa inc', 'Goodwill'],
  ['goodwill mid michigan', 'Goodwill'],
  ['goodwill north central texas', 'Goodwill'],
  ['goodwill northern michigan', 'Goodwill'],
  ['goodwill northern new england', 'Goodwill'],
  ['goodwill nynj', 'Goodwill'],
  ['goodwill of central & northern arizona', 'Goodwill'],
  ['goodwill of central and southern indiana', 'Goodwill'],
  ['goodwill of central and southern indiana, inc.', 'Goodwill'],
  ['goodwill of colorado', 'Goodwill'],
  ['goodwill of north florida', 'Goodwill'],
  ['goodwill of north georgia', 'Goodwill'],
  ['goodwill of swpa', 'Goodwill'],
  ['goodwill of the finger lakes', 'Goodwill'],
  ['goodwill of the great plains', 'Goodwill'],
  ['goodwill of the southern alleghenies', 'Goodwill'],
  ['goodwill of western & northern connecticut', 'Goodwill'],
  ['goodwill of western ny', 'Goodwill'],
  ['goodwill solac', 'Goodwill'],
  ['goodwill southeast georgia', 'Goodwill'],
  ['goodwill southern california', 'Goodwill'],
  ['goodwill southern los angeles county', 'Goodwill'],
  ['goodwill staffing', 'Goodwill'],
  ['goodwill-easter seals minnesota', 'Goodwill'],
  ['goodwill-easter seals of minnesota', 'Goodwill'],
  ['goodwillaz', 'Goodwill'],
  ['goodwillaz.wd1', 'Goodwill'],
  ['goodwillindustriesofcentraloklah', 'Goodwill'],
  ['goodwillmiddletn.wd5', 'Goodwill'],
  ['goodwillofsouthwesternpennsylvan', 'Goodwill'],
  ['goodwillsacramento', 'Goodwill'],
  ['gulfstreamgoodwillindustriesinc', 'Goodwill'],
  ['licking-knox goodwill industries', 'Goodwill'],
  ['licking-knox goodwill industries inc', 'Goodwill'],
  ['memphis goodwill', 'Goodwill'],
  ['morgan memorial goodwill industries', 'Goodwill'],
  ['ohio valley goodwill industries', 'Goodwill'],
  ['ohio valley goodwill industries rehabilitation center', 'Goodwill'],
  ['ohio valley goodwill industries rehabilitation center, inc.', 'Goodwill'],
  ['true north goodwill', 'Goodwill'],
  ['true north goodwill northern minnesota and no', 'Goodwill'],
  // Direct Cintas employer labels observed in saved jobs; match only the
  // employer itself, not agencies or other companies mentioning Cintas.
  ['cintas', 'Cintas'],
  ['cintas corp', 'Cintas'],
  ['cintas corp.', 'Cintas'],
  ['cintas corporation', 'Cintas'],
  // AO Garcia Agency's Lever tenant label and its employer display name.
  ['aogarciaagency', 'AO Garcia Agency'],
  ['ao garcia agency', 'AO Garcia Agency'],
  ['2020 companies', '2020 Companies'],
  ['2020 companies, inc.', '2020 Companies'],
  ['2020companies.wd1', '2020 Companies'],
  ['platinum supplemental insurance', 'Platinum Supplemental Insurance'],
  ['platinum supplemental insurance, inc.', 'Platinum Supplemental Insurance'],
  ['platinum supplemental insurance, inc', 'Platinum Supplemental Insurance'],
  ['platinum supplemental insurance inc.', 'Platinum Supplemental Insurance'],
  ['platinum supplemental insurance inc', 'Platinum Supplemental Insurance'],
  ['workday', 'Workday'],
  ['workday, inc.', 'Workday'],
  ['workday, inc', 'Workday'],
  ['workday inc.', 'Workday'],
  ['workday inc', 'Workday'],
  // Direct Mondelēz employer labels observed in the job sources, including
  // the US Workday entity. Exact aliases keep agencies serving it eligible.
  ['mondelēz international', 'Mondelēz International'],
  ['mondelēz international, inc.', 'Mondelēz International'],
  ['mondelēz international, inc', 'Mondelēz International'],
  ['mondelēz international inc.', 'Mondelēz International'],
  ['mondelēz international inc', 'Mondelēz International'],
  ['mondelez international', 'Mondelēz International'],
  ['mondelez international, inc.', 'Mondelēz International'],
  ['mondelez international, inc', 'Mondelēz International'],
  ['mondelez international inc.', 'Mondelēz International'],
  ['mondelez international inc', 'Mondelēz International'],
  ['mondelēz international global', 'Mondelēz International'],
  ['mondelez global llc', 'Mondelēz International'],
  ['u001 mondelez global llc', 'Mondelēz International'],
  ['mondelez vz ca', 'Mondelēz International'],
  ['mondelez australia 06', 'Mondelēz International'],
  ['mondelez in foods pvt ltd', 'Mondelēz International'],
  ['mondelez sh food corp mgt', 'Mondelēz International'],
  ['mondelez malaysia (sales)', 'Mondelēz International'],
  ['mondelez canada inc.', 'Mondelēz International'],
  ['mondelez new zealand', 'Mondelēz International'],
  ['mondelez intl service', 'Mondelēz International'],
  ['mondelez indonesia tdg', 'Mondelēz International'],
  ['mondelez kinh do vietnam', 'Mondelēz International'],
  ['mondelez philippines inc.', 'Mondelēz International'],
  ['mondelez bus services ph', 'Mondelēz International'],
  ['mondelez intl (thailand)', 'Mondelēz International'],
  ['mondelez australia 03', 'Mondelēz International'],
  ['mondelez pakistan limited', 'Mondelēz International'],
  ['mondelēz romania snacks production srl.', 'Mondelēz International'],
  ['mondelez taiwan limited', 'Mondelēz International'],
  ['mondelez thailand ltd.', 'Mondelēz International'],
  ['mondelez indonesia mfg', 'Mondelēz International'],
]);

function normalizedEmployerName(company: string | null | undefined): string {
  return String(company || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A user-selected employer exclusion; it withholds but never promotes a job. */
export function employerTriageVerdict(company: string | null | undefined): LocalTriageVerdict {
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

/** Read state coverage lists as alternatives, never as a city/state address. */
function hasMinnesotaCoverageOption(option: string): boolean {
  const value = normalizeLocationOption(option);
  // Providers put the regional label ahead of the actual state list. Only
  // discard a coverage label, not a required residence or office address.
  const list = value
    .replace(/^(?:remote|virtual|home[- ]based|field[- ]based)\s+(?:within|in|across|throughout)\s+(?:the\s+)?(?:upper\s+)?(?:midwest|central)(?:\s+(?:us|u\.s\.|region|territory))*\s*[-:]\s*/i, '')
    .replace(/^(?:remote|virtual|home[- ]based|field[- ]based)\s*[-,:]\s*/i, '');
  const states = list.split(/\s*,\s*|\s+and\s+/i).map(state => state.replace(/^and\s+/i, ''));
  const stateOnly = new RegExp(`^(?:(?:northern|southern|eastern|western|central)\\s+)?${US_STATE_LOCATION_PATTERN}$`, 'i');
  return states.length > 1
    && states.every(state => stateOnly.test(state))
    && states.some(state => /^(?:MN|Minnesota)$/i.test(state));
}

/** Missing residence evidence belongs in Aim review, not an early rejection. */
function isUnresolvedFieldLocation(option: string): boolean {
  const value = normalizeLocationOption(option)
    // This requires residence in a territory whose boundaries are unresolved;
    // it does not establish that Minneapolis is outside that territory.
    .replace(/\bmust\s+(?:live|reside)\s+(?:in|within)\s+(?:the\s+)?(?:assigned\s+)?territory$/i, '')
    .trim().replace(/[,-]$/, '')
    .trim();
  if (/^anywhere(?:\s*[, -]?\s*(?:in\s+the\s+)?(?:US|USA|United States))?$/i.test(value)) return true;
  const arrangement = '(?:remote|virtual|home[- ]based|field[- ]based)';
  const region = '(?:(?:upper\\s+)?midwest|central|eastern|western|southeastern|northeastern|northwestern|southwestern|east|west|north|south)';
  const scope = `(?:${region}(?:\\s+(?:US|USA|United States|region|territory))?|(?:US|USA|United States)\\s+${region})`;
  return new RegExp(`^(?:${arrangement}(?:\\s*[-,]?\\s*(?:${scope}|US|USA|United States))?|${scope}(?:\\s*[, -]?\\s*(?:US|USA|United States))?(?:\\s*[, -]?\\s*${arrangement})?)$`, 'i').test(value);
}

/** Worldwide availability is not evidence that Minnesota is excluded. */
const GLOBAL_SCOPE = /\b(?:anywhere in the world|worldwide|world[- ]?wide|globally|any country|anywhere on earth)\b/i;

export function locationTriageVerdict(location: string | null | undefined): LocalTriageVerdict {
  const value = (location || '').trim();
  if (!value) return PASS;
  if (hasIncompleteLocations(value)) return { pass: true, reason: 'Location list is incomplete; retain for review' };
  const options = splitLocationOptions(value);
  if (options.length === 0) return PASS;
  // A concrete in-scope option still wins — a genuinely global-remote role that
  // also lists Minneapolis is fine.
  const hasConcreteLocal = options.some((option) =>
    isMinneapolisMetroOption(option)
    || isStatewideMinnesotaOption(option)
    || isLocalMinnesotaOption(option)
    || hasMinnesotaCoverageOption(option));
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
  if (GLOBAL_SCOPE.test(value)) return { pass: true, reason: 'Worldwide availability; retain for eligibility review' };
  if (options.some(hasMinnesotaCoverageOption)) return { pass: true, reason: 'Coverage list includes Minnesota; retain for work-base review' };
  if (options.some(acceptableLocationOption)) return PASS;
  if (!hasExplicitInternational && options.every(isUnresolvedFieldLocation)) {
    return { pass: true, reason: 'Field or regional work base is unresolved; retain for eligibility review' };
  }
  return {
    pass: false,
    reason: `Location outside the searched geographies (${value.slice(0, 80)})`,
  };
}

/** A sales territory alone does not establish a required work/residence base. */
export function titleGeographyVerdict(title: string | null | undefined): LocalTriageVerdict {
  const value = (title || '').trim();
  if (!value) return PASS;
  const explicitBase = value.match(/\b(?:(?:must|need to|required to)\s+(?:currently\s+)?(?:live|reside|be based|be located)(?:\s+(?:in|within))?|(?:based|located)\s+in)\s+([^()]+?)(?:[)]|$)/i)?.[1];
  if (explicitBase && containsNonlocalGeography(explicitBase)
    && !hasMinneapolisMetroOption(explicitBase) && !hasMinnesotaLocationOption(explicitBase)) {
    return { pass: false, reason: `Title requires a non-local work base (${value})` };
  }
  // A comma-separated multi-state territory (MN, IA, NE) is still eligible.
  // Inspect the state token independently of the other territory names.
  const hasMinnesotaTerritory = /\b(?:MN|Minnesota)\b/i.test(value)
    && !/\bMinneapolis\s*,\s*(?:KS|Kansas)\b/i.test(value);
  if (hasMinneapolisMetroOption(value) || hasMinnesotaLocationOption(value) || hasMinnesotaTerritory) return PASS;
  if (!containsNonlocalGeography(value)) return PASS;
  const requiresBase = hasResidencyRequirement(value)
    || hasAssignedTerritoryResidencyRequirement(value)
    || hasRegularPresenceRequirement(value, true)
    || /\b(?:based|located)\s+in\b/i.test(value);
  return requiresBase
    ? { pass: false, reason: `Title requires a non-local work base (${value})` }
    : { pass: true, reason: 'Title names coverage geography; retain for work-base review' };
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
  const employer = employerTriageVerdict(input.company);
  if (!employer.pass) return employer;
  if (!LOCAL_TRIAGE_ENABLED) return PASS;
  const title = titleTriageVerdict(input.capRationale);
  if (!title.pass) return title;
  const geography = titleGeographyVerdict(input.title);
  if (!geography.pass) return geography;
  return locationTriageVerdict(input.location);
}
