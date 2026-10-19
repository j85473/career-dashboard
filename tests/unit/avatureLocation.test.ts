import assert from 'node:assert/strict';
import test from 'node:test';
import { avaturePublishedLocation, avaturePostingIdentity, recoverableAvatureLocation } from '../../src/lib/avatureLocation';
import { browserPostingLink, parseBrowserPosting } from '../../src/lib/browserAtsPosting';

const board = 'https://bradyplus.avature.net/careersmarketplace/SearchJobs';
const url = 'https://bradyplus.avature.net/careersmarketplace/JobDetail/Albuquerque-New-Mexico-United-States-Sales-Manager/3565';
const field = (label: string, value: string) => `<div class="article__content__view__field"><div class="article__content__view__field__label">${label}</div><div class="article__content__view__field__value">${value}</div></div>`;
const cityStateCountry = `<div class="article__content__view">${field('City', 'Albuquerque')}${field('State', 'New Mexico')}${field('Country', 'United States')}</div>`;

test('Brady Plus separate location fields reach the actual browser posting parser', () => {
  const link = browserPostingLink('avature', board, url, 'Sales Manager')!;
  const html = `<link rel="canonical" href="${url}"><header class="header__logo"><h1>Brady Plus</h1></header>${cityStateCountry}<div class="article__content">${'Responsibilities include managing sales teams and customer relationships. '.repeat(8)}</div>`;
  const result = parseBrowserPosting('avature', board, link, [{ url, html, text: '' }])!;
  assert.equal(result.location, 'Albuquerque, New Mexico, United States');
  assert.equal(result.company, 'Brady Plus');
  assert.equal(result.title, 'Sales Manager');
  assert.equal(recoverableAvatureLocation(html, url, url), result.location);
});

test('combined locations, repeated locations and country-only metadata stay published values', () => {
  assert.equal(avaturePublishedLocation(field('Location(s):', 'Toronto, ON') + field('Location', 'Vancouver, BC') + field('Location', 'Toronto, ON')), 'Toronto, ON; Vancouver, BC');
  assert.equal(avaturePublishedLocation('<div class="tf_getLocationFromCR">Location(s): Remote - US</div>'), 'Remote - US');
  assert.equal(avaturePublishedLocation(field('Country', 'Singapore')), 'Singapore');
  assert.equal(avaturePublishedLocation(field('State', 'Western Australia') + field('Country', 'Australia')), 'Western Australia, Australia');
  assert.equal(avaturePublishedLocation(field('City', 'Remote') + field('Country', 'United Kingdom')), 'Remote, United Kingdom');
});

test('published alternative and translated labels do not discard additional places', () => {
  assert.equal(avaturePublishedLocation(field('City', 'Boca Raton') + field('State', 'Florida') + field('Country', 'United States') + field('Advertised Location', 'US-FL-Boca Raton, US-FL-Fort Lauderdale')), 'US-FL-Boca Raton, US-FL-Fort Lauderdale');
  for (const [label, value] of [['Job City:', 'Montréal'], ['Ville', 'Gosport'], ['Ciudad', 'Villavicencio'], ['Locatie', 'Zaventem'], ['Ort', 'Berlin'], ['Country/Region', 'Hong Kong']]) {
    assert.equal(avaturePublishedLocation(field(label, value)), value);
  }
});

test('newer detail spans and rich-text Physical Location are metadata evidence', () => {
  const html = '<article class="article--details"><div class="fluid-cols"><p class="paragraph"><span><strong>City:</strong></span><span>Roswell</span></p><p class="paragraph"><span><strong>State:</strong></span><span>Georgia</span></p></div></article>';
  assert.equal(avaturePublishedLocation(html), 'Roswell, Georgia');
  assert.equal(avaturePublishedLocation('<div class="article__content__view__field__value"><font><strong>Physical Location:&nbsp;</strong>Pittsburgh, PA</font></div>'), 'Pittsburgh, PA');
});

test('multi-location datasets retain each place without pairing unrelated fields', () => {
  const record = (city: string, state: string, country: string) => `<ul class="MultipleDataSetFields">${[['Lugar:', city], ['Estado:', state], ['País:', country]].map(([label, value]) => `<li class="MultipleDataSetField"><span class="MultipleDataSetFieldLabel">${label}</span><span class="MultipleDataSetFieldValue">${value}</span></li>`).join('')}</ul>`;
  const html = `<div class="field--locations"><div class="article__content__view__field__value"><strong>Ubicaciones</strong>: Offsite - Georgia, Georgia, United States of America&nbsp;${record('Vancouver - Great Northern Way', 'British Columbia', 'Canada')}${record('Madison', 'Wisconsin', 'United States of America')}</div></div>`;
  assert.equal(avaturePublishedLocation(html), 'Offsite - Georgia, Georgia, United States of America; Vancouver - Great Northern Way, British Columbia, Canada; Madison, Wisconsin, United States of America');
  assert.equal(avaturePublishedLocation(html.replace('class="field--locations"', 'class="article__content__view__field field--locations"').replace('<div class="article__content__view__field__value">', '<div class="article__content__view__field__label">Locations:</div><div class="article__content__view__field__value">')), avaturePublishedLocation(html));
  assert.equal(avaturePublishedLocation(`<div class="article__content__view">${field('City', 'Austin')}${field('State', 'TX')}</div><div class="article__content__view">${field('City', 'Chicago')}${field('State', 'IL')}</div>`), 'Austin, TX; Chicago, IL');
  assert.equal(avaturePublishedLocation(field('City', 'Austin') + field('City', 'Chicago') + field('State', 'TX') + field('State', 'IL')), 'Austin; Chicago; TX; IL');
});

test('unrelated fields, script text, prose and placeholders cannot manufacture geography', () => {
  const html = field('Country', 'Unknown Location') + field('State', 'N/A') + field('City', '') + field('Function', 'Sales') + field('Work Mode', 'Hybrid') + field('Location Type', 'Remote')
    + '<script>' + cityStateCountry + '</script><footer>' + cityStateCountry + '</footer><p>City: Albuquerque. Country: United States</p><p class="paragraph"><span>City:</span><span>Anywhere</span></p>';
  assert.equal(avaturePublishedLocation(html), '');
});

test('location recovery refuses another posting, portal, tenant, or unsafe URL', () => {
  const html = `<link rel="canonical" href="${url}">${cityStateCountry}`;
  for (const other of [url.replace('3565', '3566'), url.replace('bradyplus.', 'other.'), url.replace('careersmarketplace', 'otherportal'), board, url.replace('https:', 'http:')]) {
    assert.equal(recoverableAvatureLocation(html, url, other), '');
  }
  assert.equal(recoverableAvatureLocation(html.replace('3565', '3566'), url, url), '');
  assert.equal(recoverableAvatureLocation(cityStateCountry, url, url), '');
  assert.equal(recoverableAvatureLocation(`${cityStateCountry}<a href="/careersmarketplace/ApplicationMethods?jobId=3565">Apply</a>`, url, url), 'Albuquerque, New Mexico, United States');
  for (const bad of [url.replace('https:', 'http:'), url.replace('.net/', '.net.evil.example/'), url.replace('https://', 'https://user@'), url.replace('.net/', '.net:8443/')]) assert.equal(avaturePostingIdentity(bad), null);
  assert.equal(avaturePostingIdentity(url.replace('JobDetail', 'FolderDetail')), avaturePostingIdentity(url));
});
