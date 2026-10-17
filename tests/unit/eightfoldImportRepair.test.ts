import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseJsonLdPostingHtml } from '../../src/lib/atsApi';
import { planEightfoldImportRepair } from '../../src/lib/eightfoldImportRepair';

const url = 'https://talent.bayer.com/careers/job/562949975187846?hl=en';
const html = readFileSync(new URL('../fixtures/bayer-eightfold.html', import.meta.url), 'utf8');
const recovered = parseJsonLdPostingHtml(html, url)!;
const before = {
  title: recovered.title!.slice(0, 50), company: 'Unknown Company', employer: 'Unknown Company',
  location: null, source: 'Manual Import', url,
  description: `Title: Selected role\nURL Source: ${url}\nMarkdown Content:\n\`{"themeOptions":{"customTheme":{}}}\``,
  status: 'applied', scoringStatus: 'scored', aimFitScore: 91, reqFitScore: 87,
  fitScore: 89, fitRationale: 'Retained assessment', reqFitRationale: 'Retained experience',
};

test('single-card repair restores verified metadata and JD without touching Applied or any score fields', () => {
  const patch = planEightfoldImportRepair(before, recovered);
  const after = { ...before, ...patch };
  assert.equal(after.title, recovered.title);
  assert.equal(after.company, 'Bayer');
  assert.equal(after.location, 'Residence Based,Minnesota,United States');
  assert.equal(after.description, recovered.text);
  for (const field of ['status', 'scoringStatus', 'aimFitScore', 'reqFitScore', 'fitScore', 'fitRationale', 'reqFitRationale'] as const) {
    assert.equal(after[field], before[field]);
    assert.equal(field in patch, false);
  }
  assert.throws(() => planEightfoldImportRepair({ ...before, company: 'Different Employer' }, recovered), /conflicts/);
  assert.throws(() => planEightfoldImportRepair({ ...before, employer: 'Different Employer' }, recovered), /conflicts/);
  assert.throws(() => planEightfoldImportRepair({ ...before, title: 'Sales Agronomist' }, recovered), /conflicts/);
  assert.throws(() => planEightfoldImportRepair({ ...before, description: 'Existing valid job evidence' }, recovered), /corruption/);
  assert.throws(() => planEightfoldImportRepair({ ...before, source: 'ATS' }, recovered), /corruption/);
  assert.throws(() => planEightfoldImportRepair(before, { ...recovered, text: 'Loading...' }), /could not be verified/);
});
