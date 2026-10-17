import { normalizeJobLocation } from './jobIngestion';
import { isExplicitInternationalLocationOption, splitLocationOptions } from './jobLocationPolicy';

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms',
  missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh',
  'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd',
  ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri',
  'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut',
  vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi',
  wyoming: 'wy', 'district of columbia': 'dc',
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));
const STATE_PATTERN = Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length)
  .concat([...STATE_CODES]).join('|');
const STATE_SUFFIX = new RegExp(`^(.+?)[,\\s]+(${STATE_PATTERN})(?:\\s+\\d{5}(?:-\\d{4})?)?$`, 'i');

function isWorldwideLocation(value: string): boolean {
  return /^(?:remote\s*[/,-]?\s*)?(?:anywhere(?: in the world)?|worldwide|global)(?:\s*[/,-]?\s*remote)?$/i.test(value.trim());
}

function isBroadUsLocation(normalized: string): boolean {
  const withoutRemote = normalized.replace(/\bremote\b/g, ' ').replace(/\s+/g, ' ').trim();
  return withoutRemote === '' || withoutRemote === 'us';
}

function isUnspecifiedLocation(value: string): boolean {
  const normalized = normalizeJobLocation(value);
  return normalized === 'unknown'
    || /^(?:unknown location|location unknown|location not specified|unspecified|not available|multiple locations?|(?:n|\d+) locations?|additional locations unresolved)$/.test(normalized);
}

function locationOptions(value: string | null | undefined): string[] {
  const raw = String(value || '');
  // Preserve publisher placeholders such as N/A before slash splitting.
  if (isUnspecifiedLocation(raw)) return [raw];
  const options = splitLocationOptions(raw.replace(/\bn\s*\/\s*a\b/gi, 'Unknown'));
  // A work arrangement written beside a place is a qualifier, not another
  // eligible location. In particular, "Canada / Remote" must remain Canadian.
  const specific = options.filter(option => !/^(?:remote|hybrid|on[- ]?site)$/i.test(option)
    && !isUnspecifiedLocation(option));
  return specific.length ? specific : options.length ? options : [''];
}

function domesticPlace(value: string): { city: string; state: string | null } {
  const clean = value.trim()
    .replace(/^(?:united states(?: of america)?|u\.?s\.?a?\.?)\s*[-,]\s*/i, '')
    .replace(/\b(?:united states(?: of america)?|u\.?s\.?a?)\s*$/i, '')
    .replace(/^(?:remote|hybrid|on[- ]?site)\s*[-,:]?\s*/i, '')
    .replace(/\s*[, -]?\s*(?:remote|hybrid|on[- ]?site)$/i, '')
    .replace(/[\s,]+$/, '');
  const stateOnly = clean.toLowerCase();
  if (STATE_NAMES[stateOnly] || STATE_CODES.has(stateOnly)) {
    return { city: '', state: STATE_NAMES[stateOnly] || stateOnly };
  }
  const stateFirst = clean.match(/^([A-Z]{2})\s*[-,]\s*(.+)$/);
  if (stateFirst && STATE_CODES.has(stateFirst[1].toLowerCase())) {
    return { city: normalizeJobLocation(stateFirst[2]), state: stateFirst[1].toLowerCase() };
  }
  const suffix = clean.match(STATE_SUFFIX);
  if (suffix) {
    const state = suffix[2].toLowerCase();
    return { city: normalizeJobLocation(suffix[1]), state: STATE_NAMES[state] || state };
  }
  return { city: normalizeJobLocation(clean.split(',')[0] || ''), state: null };
}

function optionsCompatible(leftOption: string, rightOption: string): boolean {
  const left = normalizeJobLocation(leftOption);
  const right = normalizeJobLocation(rightOption);
  if (left === right) return true;
  if (isUnspecifiedLocation(leftOption) || isUnspecifiedLocation(rightOption)) return true;
  if (isWorldwideLocation(leftOption) || isWorldwideLocation(rightOption)) return true;

  // Preserve original state-code casing for the country classifier: lowercased
  // "IN-Indianapolis" otherwise becomes an apparent India country prefix.
  const leftForeign = isExplicitInternationalLocationOption(leftOption);
  const rightForeign = isExplicitInternationalLocationOption(rightOption);
  if (leftForeign !== rightForeign) return false;
  if (leftForeign && rightForeign) return left.includes(right) || right.includes(left);
  if (isBroadUsLocation(left) || isBroadUsLocation(right)) return true;

  const a = domesticPlace(leftOption);
  const b = domesticPlace(rightOption);
  if (a.state && b.state && a.state !== b.state) return false;
  if (a.state && a.state === b.state && (!a.city || !b.city)) return true;
  // A matching city is useful only when the two explicit states do not disagree.
  // No nearby-city or metro substitution is made here.
  return a.city === b.city;
}

/** Compare each eligible site rather than interpreting a whole list as one city. */
export function locationsCompatibleForDirectMatch(
  aggregatorLocation: string | null | undefined,
  postingLocation: string | null | undefined,
): boolean {
  const left = locationOptions(aggregatorLocation);
  const right = locationOptions(postingLocation);
  return left.some(a => right.some(b => optionsCompatible(a, b)));
}
