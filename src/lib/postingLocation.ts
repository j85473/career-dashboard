/** Explicit evidence that the displayed sites are only part of the posting. */
export const INCOMPLETE_LOCATION = 'Additional locations unresolved';

export function hasIncompleteLocations(value: string): boolean {
  return /additional locations unresolved|\+\s*[1-9]\d*\s+more locations?|^\s*[1-9]\d*\s+(?:more|additional)\s+locations?\s*$|\bselect locations\b/im.test(value);
}

export const US_STATE_LOCATION_PATTERN = '(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia)';

/** Separate complete city/state options without splitting a city's address. */
export function separateCommaLocations(value: string): string {
  const state = US_STATE_LOCATION_PATTERN;

  return value.replace(new RegExp(`(,\\s*${state}(?:\\s+\\d{5}(?:-\\d{4})?)?(?:,\\s*(?:US|USA|United States(?: of America)?))?),\\s*(?!(?:US|USA|United States(?: of America)?)(?:[,;]|$))(?=[A-Za-z][^,;]+,\\s*${state}\\b)`, 'gi'), '$1; ');
}

export function providerPostingLocation(job: {
  location?: unknown;
  categories?: { location?: unknown; allLocations?: unknown };
  secondaryLocations?: Array<{ location?: unknown }>;
  workplaceType?: unknown;
}): string | undefined {
  const primary = typeof job.location === 'object' && job.location !== null
    ? (job.location as { name?: unknown }).name : job.location;
  const values = [job.categories?.location || primary,
    ...(Array.isArray(job.categories?.allLocations) ? job.categories.allLocations : []),
    ...(Array.isArray(job.secondaryLocations) ? job.secondaryLocations : []).map(place => place?.location)]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map(value => value.trim());
  // Workplace type describes the listed places; it is not an extra eligible site.
  const location = [...new Set(values)].join('; ');
  return location || undefined;
}
