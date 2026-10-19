type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const placeText = (value: unknown) => /^(?:unknown(?: location)?|not specified|not provided|n\/a|-+)$/i.test(text(value)) ? '' : text(value);

function workMode(value: unknown): string {
  const name = text(value);
  if (/^remote(?: job)?$/i.test(name)) return 'Remote';
  if (/^hybrid(?: job)?$/i.test(name)) return 'Hybrid';
  if (/^on[- ]site(?: job)?$/i.test(name)) return 'On-site';
  return '';
}

export function isRecruiteeWorkModeOnlyLocation(value: unknown): boolean {
  const parts = text(value).split(/\s*\/\s*/);
  return parts.length > 0 && parts.every(part => !!workMode(part));
}

/** The API's `location` can be only "Remote job"; `locations` retains the geography. */
export function recruiteePostingLocation(value: unknown): string {
  const job = row(value);
  const modes = unique([job.remote === true ? 'Remote' : '', job.hybrid === true ? 'Hybrid' : '',
    job.on_site === true ? 'On-site' : '', workMode(job.location)]);
  const geography = (value: unknown) => {
    const place = row(value);
    const city = placeText(place.city);
    const cityMode = workMode(city);
    if (cityMode && !modes.includes(cityMode)) modes.push(cityMode);
    const parts = unique([cityMode ? '' : city, placeText(place.state) || placeText(place.state_name), placeText(place.country)]);
    if (parts.length) return parts.join(', ');
    const name = placeText(place.name);
    const nameMode = workMode(name);
    if (nameMode && !modes.includes(nameMode)) modes.push(nameMode);
    return nameMode ? '' : name;
  };
  let places = unique((Array.isArray(job.locations) ? job.locations : []).map(geography));
  if (!places.length) {
    const flat = geography({ city: job.city, state: job.state || job.state_name, country: job.country });
    if (flat) places = [flat];
  }
  if (!places.length && text(job.location) && !workMode(job.location)) places = [text(job.location)];
  const arrangement = unique(modes).join(' / ');
  return [arrangement, places.join('; ')].filter(Boolean).join(' — ');
}

/** Restrict metadata recovery to a real posting on a single public tenant. */
export function recruiteePostingIdentity(value: string): { tenant: string; slug: string; url: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const tenant = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/i.exec(url.hostname)?.[1];
    const slug = /^\/o\/([\w-]+)\/?$/.exec(url.pathname)?.[1];
    return tenant && slug ? { tenant, slug, url: `https://${tenant}.recruitee.com/o/${slug}` } : null;
  } catch { return null; }
}
