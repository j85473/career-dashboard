const MINNEAPOLIS_METRO = /\b(?:minneapolis|st\.?\s*paul|saint paul|twin cities|arden hills|bloomington|brooklyn center|brooklyn park|burnsville|champlin|chanhassen|chaska|circle pines|columbia heights|coon rapids|cottage grove|crystal(?!\s+city)|eagan|eden prairie|edina|falcon heights|fridley|golden valley|hopkins|inver grove heights|lauderdale|lakeville|little canada|maple grove|maplewood|mendota heights|minnetonka|mounds view|new brighton|new hope|north st\.?\s*paul|oakdale|osseo|plymouth|prior lake|richfield|robbinsdale|roseville|savage|shakopee|shoreview|south st\.?\s*paul|spring lake park|st\.?\s*louis park|stillwater|vadnais heights|wayzata|west st\.?\s*paul|white bear lake|woodbury|55405|(?:550|551|553|554)\d{2})\b/i;
const LOCAL_WISCONSIN_METRO = /\b(?:hudson|river falls),?\s*(?:wi|wisconsin)\b/i;
export const OUTSTATE_MINNESOTA = /\b(?:rochester|duluth|st\.?\s*cloud|saint cloud|mankato|moorhead|bemidji|brainerd|alexandria|faribault|hibbing|marshall|owatonna|red wing|willmar|winona)\b/i;
export const INTERNATIONAL_LOCATION = /\b(?:eu|europe|dach|emea|apac|latam|uk|united kingdom|london|england|ireland|dublin|india|chennai|bengaluru|bangalore|hyderabad|pune|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|netherlands|amsterdam|belgium|brussels|italy|rome|milan|sweden|stockholm|poland|warsaw|australia|sydney|melbourne|new zealand|auckland|singapore|malaysia|philippines|vietnam|japan|tokyo|china|beijing|shanghai|brazil|brasil|sao paulo|argentina|mexico|canada|toronto|vancouver|montreal|south africa|cape town|saudi arabia|riyadh|united arab emirates|dubai)\b/i;
const NON_MINNESOTA_STATE = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/i;
const NON_MINNESOTA_STATE_CODE_AFTER_SEPARATOR = /(?:,|\(|\/|-)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/i;
const NON_MINNESOTA_STATE_CODE_ONLY = /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/i;
const NONLOCAL_MAJOR_CITY = /\b(?:austin|atlanta|baltimore|boston|charlotte|chicago|cincinnati|cleveland|columbus|dallas|denver|des moines|detroit|houston|indianapolis|kansas city|las vegas|los angeles|madison|memphis|miami|milwaukee|nashville|new york city|nyc|omaha|orlando|philadelphia|phoenix|pittsburgh|portland|raleigh|richmond|sacramento|salt lake city|san antonio|san diego|san francisco|san jose|seattle|st\.?\s*louis|tampa|washington,?\s*d\.?c\.?)\b/i;

export function splitLocationOptions(location: string): string[] {
  return location
    .split(/\s+(?:or)\s+|[;/|]/i)
    .map((option) => option.trim().replace(/^[([]+|[)\]]+$/g, '').trim())
    .filter(Boolean);
}

export function normalizeLocationOption(option: string): string {
  return option
    .normalize('NFKC')
    .trim()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasNonMinnesotaStateMarker(text: string): boolean {
  return NON_MINNESOTA_STATE.test(text)
    || NON_MINNESOTA_STATE_CODE_AFTER_SEPARATOR.test(text)
    || NON_MINNESOTA_STATE_CODE_ONLY.test(text.trim());
}

export function isMinneapolisMetroOption(option: string): boolean {
  if (LOCAL_WISCONSIN_METRO.test(option)) return true;
  return MINNEAPOLIS_METRO.test(option) && !hasNonMinnesotaStateMarker(option);
}

export function hasMinneapolisMetroOption(location: string): boolean {
  return splitLocationOptions(location).some(isMinneapolisMetroOption);
}

export function isStatewideMinnesotaOption(option: string): boolean {
  return /^(?:(?:remote|virtual)\s*[-,]?\s*)?(?:mn|minnesota)(?:,\s*(?:u\.?s\.?a?|united states))?(?:\s*[-,]?\s*(?:remote|virtual))?$/i.test(normalizeLocationOption(option));
}

export function hasStatewideMinnesotaOption(location: string): boolean {
  return splitLocationOptions(location).some(isStatewideMinnesotaOption);
}

export function isMinnesotaLocationOption(option: string): boolean {
  const normalized = normalizeLocationOption(option);
  return /(?:^|,|\s)(?:mn|minnesota)(?:\s|,|$)/i.test(normalized)
    && !hasNonMinnesotaStateMarker(normalized.replace(/\b(?:mn|minnesota)\b/gi, ' '));
}

export function hasMinnesotaLocationOption(location: string): boolean {
  return splitLocationOptions(location).some(isMinnesotaLocationOption);
}

/**
 * An explicitly-Minnesota location that is not outstate.
 *
 * `MINNEAPOLIS_METRO` is a hand-maintained list of ~50 municipalities, and
 * `isStatewideMinnesotaOption` only matches a bare "MN" or "Minnesota". A city
 * that is plainly in Minnesota but absent from the list therefore matched
 * neither, and the triage gate dismissed it as "outside the searched
 * geographies" — Blaine (pop. 70,000), Apple Valley, Anoka, Andover, Rosemount,
 * Farmington, Hastings, Elk River, Forest Lake, Lake Elmo, Lino Lakes, Ham
 * Lake, Hugo and Ramsey all failed. There are roughly ninety metro
 * municipalities, so extending the list is a recurring defect rather than a fix.
 *
 * Reading the state marker generalises instead of enumerating. Outstate stays
 * excluded: Rochester, Duluth and St. Cloud are in Minnesota but are not
 * commutable, which is why `OUTSTATE_MINNESOTA` exists as its own set.
 */
export function isLocalMinnesotaOption(option: string): boolean {
  return isMinnesotaLocationOption(option) && !OUTSTATE_MINNESOTA.test(normalizeLocationOption(option));
}

export function isUnknownOrBroadUSOption(option: string): boolean {
  return /^(?:unknown(?: location)?|n\/a|not specified|multiple locations?|n locations?|\d+ locations?|u\.?s\.?a?|united states(?: of america)?)$/i.test(normalizeLocationOption(option));
}

export function isGeneralRemoteOption(option: string): boolean {
  const trimmed = normalizeLocationOption(option);
  return /^(?:(?:remote|virtual|home[- ]based|work from home|work at home|distributed|flexible)(?:\s*[-,]?\s*(?:(?:anywhere\s*[-,]?\s*)?(?:all\s+u\.?s\.?|u\.?s\.?\s+only|u\.?s\.?a?|united states)|worldwide))?|(?:u\.?s\.?a?|united states)(?:\s*[-,]?\s*remote[- ]first|\s*[-,]?\s*(?:remote|virtual|home[- ]based|work from home|work at home)))$/i.test(trimmed);
}

export function hasGeneralRemoteOption(location: string): boolean {
  return splitLocationOptions(location).some(isGeneralRemoteOption);
}

export function hasExplicitUSRemoteOption(location: string): boolean {
  return splitLocationOptions(location).some((option) => {
    const trimmed = normalizeLocationOption(option);
    return /^(?:(?:remote|virtual|home[- ]based|work from home|work at home|distributed)\s*[-,]?\s*(?:anywhere\s*[-,]?\s*)?(?:u\.?s\.?a?|united states)|(?:u\.?s\.?a?|united states)\s*[-,]?\s*(?:remote|virtual|home[- ]based|work from home|work at home))$/i.test(trimmed);
  });
}

export function hasExplicitRemoteExclusion(text: string): boolean {
  return /\b(?:this\s+(?:role|position|job)\s+is\s+not|not\s+(?:a\s+)?|cannot\s+be|can't\s+be|non[\s-])remote\b/i.test(text)
    || /\bremote\s+work\s+(?:is\s+)?not\s+(?:available|allowed|offered|permitted)\b/i.test(text)
    || /\bno\s+remote(?:\s+work)?\b/i.test(text)
    || /\bremote[\s-]only candidates?\s+(?:will not|won't|do not|don't|are not)\b/i.test(text)
    || /\b(?:on[\s-]?site|in[\s-]?office|office[\s-]?based)\s+only\b/i.test(text);
}

export function hasExplicitUnitedStatesReference(text: string): boolean {
  return /\bunited states(?: of america)?\b/i.test(text)
    || /\b(?:US|USA|U\.S\.?|U\.S\.A\.?)\b/.test(text)
    || /\ball 50 states\b/i.test(text);
}

export function hasExplicitNationalRemoteEvidence(text: string): boolean {
  const normalized = text
    .replace(/\bnot\s+(?:a\s+)?remote\s+(?:role|position|job)\b/gi, ' ')
    .replace(/\bremote\s+work\s+(?:is\s+)?not\s+(?:available|allowed|offered|permitted)\b/gi, ' ')
    .replace(/\bno\s+remote(?:\s+work)?\b/gi, ' ');
  if (!hasExplicitUnitedStatesReference(normalized)) return false;
  return /\b(?:fully|entirely|completely|100\s*%)\s+remote\s+(?:role|position|job|work arrangement)?\b.{0,80}\b(?:u\.?s\.?a?|united states|nationwide)\b/i.test(normalized)
    || /\b(?:u\.?s\.?a?|united states|nationwide)\b.{0,80}\b(?:fully|entirely|completely|100\s*%)\s+remote\b/i.test(normalized)
    || /\b(?:remote|home[- ]based)\s+(?:role|position|job|work arrangement)\b.{0,80}\b(?:across|throughout|anywhere in|open to candidates in)\s+(?:the\s+)?(?:u\.?s\.?a?|united states)\b/i.test(normalized)
    || /\b(?:may|can|could|are free to)\s+(?:live|reside|be based|work)\s+anywhere\s+(?:in|within|across)\s+(?:the\s+)?(?:u\.?s\.?a?|united states)\b/i.test(normalized)
    || /\bwork\s+from\s+anywhere\s+in\s+(?:the\s+)?(?:u\.?s\.?a?|united states)\b/i.test(normalized)
    || /\b(?:open|available)\s+to\s+candidates?\s+(?:nationwide\s+in|across|throughout)\s+(?:the\s+)?(?:u\.?s\.?a?|united states)\b/i.test(normalized)
    || /\b(?:all\s+50\s+states|u\.?s\.?[- ]wide\s+remote)\b/i.test(normalized);
}

export function containsNonlocalGeography(text: string): boolean {
  return OUTSTATE_MINNESOTA.test(text)
    || INTERNATIONAL_LOCATION.test(text)
    || NON_MINNESOTA_STATE.test(text)
    || NON_MINNESOTA_STATE_CODE_AFTER_SEPARATOR.test(text)
    || NONLOCAL_MAJOR_CITY.test(text);
}

export function containsSpecificNonlocalMetadata(location: string): boolean {
  return splitLocationOptions(location).some((option) => {
    if (isMinneapolisMetroOption(option)
      || isStatewideMinnesotaOption(option)
      || isUnknownOrBroadUSOption(option)
      || isGeneralRemoteOption(option)) return false;
    return true;
  });
}

export function hasRegularPresenceRequirement(text: string, metadata = false): boolean {
  if (metadata && /\b(?:hybrid|on[- ]?site|in[- ]office|office[- ]based)\b/i.test(text)) return true;
  return /\bhybrid\s+(?:role|position|schedule|work arrangement)\b/i.test(text)
    || /\b(?:role|position|job|schedule|work arrangement)\s+(?:is|will be|operates as)\s+(?:a\s+)?hybrid\b/i.test(text)
    || /\b(?:on[- ]?site|in[- ]office|office[- ]based)\s+(?:role|position|job|schedule|attendance|requirement)\b/i.test(text)
    || /\b(?:must|required|expected)\s+(?:to\s+)?(?:work|report|come|be)\b.{0,60}\b(?:on[- ]?site|in[- ]office|in (?:the|our) office|at (?:the|our) office)\b/i.test(text)
    || /\b(?:one|two|three|four|five|\d+)\s+days?\s+(?:per|a|each)\s+week\b.{0,50}\b(?:office|on[- ]?site)\b/i.test(text)
    || /\b(?:work|working)\s+from\s+(?:the|our|an?)\s+[^.\n]{0,40}\boffice\b/i.test(text);
}

export function hasResidencyRequirement(text: string): boolean {
  return /\b(?:candidates?|applicants?|employees?|you)\s+(?:must|need to|are required to)\s+(?:currently\s+)?(?:live|reside|be based|be located|be within commuting distance)\b/i.test(text)
    || /\b(?:must|need to|required to)\s+(?:currently\s+)?(?:live|reside|be based|be located|be within commuting distance)\b/i.test(text)
    || /\bonly\s+(?:available|open)\s+to\s+candidates?\s+who\s+(?:live|reside|are based|are located)\b/i.test(text)
    || /\bremote\s+(?:role|position|job)?\s*(?:is\s+)?(?:limited|restricted)\s+to\b/i.test(text);
}

export function hasAssignedTerritoryResidencyRequirement(text: string): boolean {
  return /\b(?:must|need to|required to|are required to)\s+(?:currently\s+)?(?:live|reside|be based|be located)(?:\s+(?:in|within))?\s+(?:the\s+)?(?:assigned|designated|sales)?\s*territor(?:y|ies)\b/i.test(text)
    || /\b(?:live|reside|based|located)\s+(?:in|within)\s+(?:the\s+)?(?:assigned|designated|sales)\s+territor(?:y|ies)\s+(?:is\s+)?required\b/i.test(text);
}

export function hasInternationalWorkBaseRequirement(text: string): boolean {
  if (!INTERNATIONAL_LOCATION.test(text)) return false;
  return hasResidencyRequirement(text)
    || /\b(?:role|position|job|candidate|applicant|employee)\b.{0,45}\b(?:based|located)\s+(?:in|within)\b/i.test(text)
    || /\b(?:work|working)\s+(?:from|anywhere(?:\s+(?:in|across|within))?)\b/i.test(text)
    || /\b(?:open|available)\s+(?:to\s+candidates?\s+)?(?:in|across|throughout|within)\b/i.test(text);
}

export type RequiredWorkBaseCompatibility = 'compatible' | 'incompatible' | 'unknown';

export function classifyRequiredWorkBaseEvidence(evidence: readonly string[]): RequiredWorkBaseCompatibility {
  if (evidence.length === 0) return 'unknown';
  const text = evidence.join('\n');
  const required = hasResidencyRequirement(text) || hasRegularPresenceRequirement(text) || hasInternationalWorkBaseRequirement(text)
    || /\b(?:must|required|need to|expected to)\s+(?:be\s+)?(?:based|located|commute)\b/i.test(text);
  if (!required) return 'unknown';
  if (hasMinneapolisMetroOption(text) || hasMinnesotaLocationOption(text) || hasStatewideMinnesotaOption(text) || hasGeneralRemoteOption(text) || hasExplicitNationalRemoteEvidence(text)) {
    return 'compatible';
  }
  if (containsNonlocalGeography(text)) return 'incompatible';
  return 'unknown';
}
