import zipcodes from 'zipcodes';
import { splitLocationOptions } from './jobLocationPolicy';
import type { Prisma } from './prismaClient';
import cityData from '../data/usSearchCities.json';

type Point = { latitude: number; longitude: number };
type City = Point & { city: string; state: string; label: string };
export type JobLocationFilter =
  | { kind: 'state'; state: string; label: string }
  | { kind: 'radius'; center: Point; miles: number; label: string };

export class LocationSearchError extends Error {}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\bst[.]?(?=\s)/g, 'saint').replace(/\bft[.]?(?=\s)/g, 'fort')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const states = new Map<string, string>();
for (const [code, name] of Object.entries(zipcodes.states.abbr)) {
  states.set(normalize(code), code);
  states.set(normalize(name), code);
}
const stateNames = zipcodes.states.abbr;
const cities = new Map<string, City>();
const citiesByName = new Map<string, City[]>();
const groups = new Map<string, zipcodes.ZipCode[]>();
for (const place of Object.values(zipcodes.codes)) {
  if (place.country !== 'US' || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)
    || (place.latitude === 0 && place.longitude === 0)) continue;
  const key = `${normalize(place.city)} ${place.state}`;
  const group = groups.get(key) || [];
  group.push(place);
  groups.set(key, group);
}
for (const [key, group] of groups) {
  const first = group[0];
  const city: City = {
    city: normalize(first.city), state: first.state, label: `${first.city}, ${first.state}`,
    latitude: group.reduce((sum, place) => sum + place.latitude, 0) / group.length,
    longitude: group.reduce((sum, place) => sum + place.longitude, 0) / group.length,
  };
  cities.set(key, city);
  const named = citiesByName.get(city.city) || [];
  named.push(city);
  citiesByName.set(city.city, named);
}
// Postal city names omit suburbs such as Edina and Bloomington. Prefer the
// actual city center where the separate GeoNames gazetteer has one.
for (const [name, state, latitude, longitude] of cityData as Array<[string, string, number, number]>) {
  const city: City = { city: normalize(name), state, latitude, longitude, label: `${name}, ${state}` };
  const key = `${city.city} ${state}`;
  cities.set(key, city);
  const named = (citiesByName.get(city.city) || []).filter(item => item.state !== state);
  citiesByName.set(city.city, [...named, city]);
}

/** Local US gazetteer; no network request or changes to saved job locations. */
function parsePlace(value: string): { state?: string; city?: string; zip?: string } {
  const clean = normalize(value.replace(/\b\d{5}-\d{4}\b/g, zip => zip.slice(0, 5)));
  if (/^\d{5}$/.test(clean)) return { zip: clean };
  const zip = clean.match(/\b\d{5}\b/);
  if (zip) return { ...parsePlace(clean.replace(/\b\d{5}\b/, '').trim()), zip: zip[0] };
  if (states.has(clean)) return { state: states.get(clean) };
  for (const [name, state] of states) {
    if (clean.endsWith(` ${name}`)) return { city: clean.slice(0, -name.length).trim(), state };
  }
  for (const [name, state] of states) {
    if (clean.startsWith(`${name} `)) return { city: clean.slice(name.length).trim(), state };
  }
  return { city: clean };
}

export function resolveJobLocationFilter(location: string, radius: string | null): JobLocationFilter | null {
  const value = location.trim();
  if (!value) {
    if (radius !== null && radius !== '') throw new LocationSearchError('Enter a city, state, or ZIP code for the distance filter.');
    return null;
  }
  if (value.length > 120) throw new LocationSearchError('Enter a US city, state, or ZIP code.');
  const miles = radius === null || radius === '' ? 25 : Number(radius);
  if (!Number.isFinite(miles) || miles < 1 || miles > 500) {
    throw new LocationSearchError('Choose a distance between 1 and 500 miles.');
  }
  const place = parsePlace(value);
  if (place.state && !place.city && !place.zip) {
    const name = stateNames[place.state].toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
    return { kind: 'state', state: place.state, label: `${name} (entire state)` };
  }
  if (place.zip) {
    const zip = zipcodes.lookup(place.zip);
    if (zip?.country === 'US' && groups.has(`${normalize(zip.city)} ${zip.state}`)) {
      if (place.state && place.state !== zip.state) throw new LocationSearchError('The state and ZIP code do not match. Check the location and try again.');
      if (place.city) {
        const city = cities.get(`${place.city} ${zip.state}`);
        if (!city || distanceMiles(city, zip) > 50) throw new LocationSearchError('The city and ZIP code do not match. Check the location and try again.');
      }
      return { kind: 'radius', center: zip, miles, label: `Within ${miles} miles of ${zip.city}, ${zip.state} ${place.zip}` };
    }
  } else if (place.city) {
    const matches = place.state
      ? [cities.get(`${place.city} ${place.state}`)].filter((city): city is City => Boolean(city))
      : citiesByName.get(place.city) || [];
    if (matches.length === 1) return { kind: 'radius', center: matches[0], miles, label: `Within ${miles} miles of ${matches[0].label}` };
    if (matches.length > 1) {
      throw new LocationSearchError(`Add a state or ZIP code to distinguish ${matches.slice(0, 4).map(city => city.label).join('; ')}${matches.length > 4 ? '; and other matches' : ''}.`);
    }
  }
  throw new LocationSearchError('Location not found. Enter a US city and state (such as Minneapolis, MN), a state, or a five-digit ZIP code.');
}

export function distanceMiles(a: Point, b: Point): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const h = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude))
      * Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function postedPlace(option: string) {
  // Strip work arrangements and US country labels, retaining an explicit foreign country.
  const clean = option.replace(/\b(?:remote|hybrid|on[- ]?site|office)\b/gi, ' ')
    .replace(/\b(?:united states(?: of america)?|usa|us)\b/gi, ' ')
    .replace(/^[\s,():-]+|[\s,():-]+$/g, '');
  const zip = clean.match(/\b\d{5}(?:-\d{4})?\b/);
  const withoutZip = clean.replace(/\b\d{5}(?:-\d{4})?\b/g, '').trim();
  const place = parsePlace(withoutZip);
  // A ZIP code is usable only when the remaining text is an actual US place.
  const namedCity = place.city && place.state ? cities.get(`${place.city} ${place.state}`) : undefined;
  const zipPlace = zip ? zipcodes.lookup(zip[0].slice(0, 5)) : undefined;
  if (zipPlace?.country === 'US' && (!normalize(withoutZip) || namedCity
    || (place.state === zipPlace.state && !place.city))) {
    if (place.state && place.state !== zipPlace.state) return null;
    return { state: zipPlace.state, point: zipPlace };
  }
  if (place.state && !place.city) return { state: place.state, point: null };
  if (namedCity) return { state: namedCity.state, point: namedCity };
  const matches = !place.state && place.city ? citiesByName.get(place.city) : undefined;
  return matches?.length === 1 ? { state: matches[0].state, point: matches[0] } : null;
}

export function jobMatchesLocation(location: string | null, filter: JobLocationFilter): boolean {
  return splitLocationOptions(location || '').some(option => {
    const place = postedPlace(option);
    if (!place) return false;
    if (filter.kind === 'state') return place.state === filter.state;
    return place.point !== null && distanceMiles(filter.center, place.point) <= filter.miles;
  });
}

export async function jobLocationSearchValues(
  filter: JobLocationFilter,
  scope: Prisma.JobWhereInput,
  db: Pick<Prisma.TransactionClient, 'job'>,
): Promise<string[]> {
  // Group on the server instead of downloading each job or its description.
  const rows = await db.job.groupBy({ by: ['location'], where: scope });
  return rows.flatMap(row => row.location && jobMatchesLocation(row.location, filter) ? [row.location] : []);
}
