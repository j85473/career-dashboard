// Regenerate the offline US city centers: node scripts/build_search_city_data.mjs
// Source: all-the-cities 3.1.0 (MIT), derived from GeoNames (CC BY 4.0).
import allCities from 'all-the-cities';
import { mkdir, writeFile } from 'node:fs/promises';

const cities = new Map();
// Prefer the larger settlement if names repeat within a state.
for (const city of allCities.filter(city => city.country === 'US')
  .sort((a, b) => b.population - a.population || a.cityId - b.cityId)) {
  const key = `${city.name}|${city.adminCode}`;
  if (!cities.has(key)) cities.set(key, [city.name, city.adminCode, city.loc.coordinates[1], city.loc.coordinates[0]]);
}
await mkdir(new URL('../src/data/', import.meta.url), { recursive: true });
await writeFile(new URL('../src/data/usSearchCities.json', import.meta.url),
  `${JSON.stringify([...cities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, city]) => city))}\n`);
