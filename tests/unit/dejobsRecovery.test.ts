import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanDejobsMarkdown,
  extractDejobsJobId,
  extractDejobsShortlinkId,
  parseDejobsJson,
} from '../../src/lib/atsApi';
import { assessJobDescriptionQuality } from '../../src/lib/jobDescriptionQuality';

/**
 * `scrapeAtsApi`'s dejobs branch (network calls, untested here like the rest
 * of atsApi.ts's live handlers) resolves a job ID from the redirect chain's
 * final URL and cleans the JSON's Markdown `description`. These are the two
 * pure steps in that path, and the ones a wrong regex or a leftover `**`
 * marker would silently break.
 */

test('extracts the 32-character hex job ID from real dejobs detail URLs, case-insensitively', () => {
  assert.equal(
    extractDejobsJobId('https://dejobs.org/budapest-hun/key-account-manager-oncology/C7F536F088CA4004971D9E61C44A8103/job/'),
    'C7F536F088CA4004971D9E61C44A8103',
  );
  assert.equal(
    extractDejobsJobId('https://publicstorage.dejobs.org/28e4d6ccf02f4ddab911a34cb227f13b/job/?vs=8003'),
    '28E4D6CCF02F4DDAB911A34CB227F13B',
  );
  assert.equal(
    extractDejobsJobId('https://dejobs.org/peabody-ma/field-sales-manager/790BDEA8618C4660B77202DA9A2403A6/job'),
    '790BDEA8618C4660B77202DA9A2403A6',
  );
});

test('returns null for URLs that are not a dejobs detail page', () => {
  // Landed on the employer's own ATS after the redirect -- not a dejobs URL at all.
  assert.equal(
    extractDejobsJobId('https://hyvee.wd1.myworkdayjobs.com/HyVeeCareers/job/Rochester/Customer-Service_R246800'),
    null,
  );
  // The short jobsyn.org redirector itself carries no job ID in its path.
  assert.equal(extractDejobsJobId('https://de.jobsyn.org/b2b784fffd724b49a617482a6a2a8ea58003'), null);
  assert.equal(extractDejobsJobId('not a url'), null);
});

// A real `description` field pulled from microsites.dejobs.org, padding and
// all: two-space-then-newline between every block, `**bold**`, `+` bullets.
const REAL_DEJOBS_DESCRIPTION = 'We are seeking a\n  \n\n  \n**Key Account Manager to Oncology-Hematology team**\n  \n\n  \n'
  + 'to  **Western and Southern Hungary**\n  \n\n  \n**We offer:**\n  \n\n  \n+ Stable, leading international biotechnology company\n  \n'
  + '+ Part of a great team\n  \n+ Innovative portfolio\n  \n+ Competitive benefits with company car\n  \n\n  \n'
  + '**Responsibilities:**\n  \n\n  \n'
  + '+ Act as an ambassador of our purpose – drives impact on self-care in Hungary through the assigned customers.\n  \n'
  + '+ Manage own territory\n  \n+ Keep contact with relevant stakeholders\n  \n'
  + '+ Differentiate Amgen product that the appropriate patients receive relevant treatment\n  \n'
  + '+ Map decision processes and identify key decision makers\n  \n'
  + '+ Implement and monitor an action plan for the accounts on territory based on deeper analysis\n  \n'
  + '+ Execute commercial activities aligned with company strategy\n  \n'
  + '+ Manage territory budget and resources effectively\n  \n'
  + '+ Account level planning of interactions based on customer preferences\n  \n'
  + '+ Monitor market changes, including competitors, reimbursement, and new therapies\n  \n\n  \n'
  + '**Requirements:**\n  \n\n  \n'
  + '+ “Patient first” mindset\n  \n+ “can do” attitude\n  \n+ Digital affinity\n  \n'
  + '+ Learning agility\n  \n+ High ethical standard\n  \n\n  \n'
  + '+  **Life science College/University degree**\n  \n'
  + '+ 2-4 years experience in innovative  **pharmaceutical industry**  as Key Account Manager\n  \n'
  + '+ Experience in Oncology\n  \n+ Experience in delivering scientific or promotional presentations\n  \n'
  + '+ Native Hungarian language\n  \n+ Fluent in English communication (written and spoken)\n  \n'
  + '+ Confidence in using digital tools and platforms\n  \n'
  + '+ High level of communication skills, able to communicate to different people on different level\n  \n'
  + '+ Dynamic and positive attitude\n  \n+ Able to work independently and as part of a team\n  \n'
  + '+ Be open minded confident and able to communicate to stakeholders at all levels\n  \n'
  + '+ Home address in Budapest or Western-Hungary.';

test('cleans the JSON description Markdown into prose that clears the quality gate', () => {
  const cleaned = cleanDejobsMarkdown(REAL_DEJOBS_DESCRIPTION);

  assert.equal(cleaned.includes('**'), false);
  assert.equal(cleaned.includes('  \n'), false);
  assert.match(cleaned, /- Manage own territory/);
  assert.match(cleaned, /Responsibilities:/);
  // The gate looks for real sections and vocabulary, not raw Markdown syntax.
  const quality = assessJobDescriptionQuality(cleaned);
  assert.equal(quality.scorable, true, quality.reason ?? '');
});

/**
 * The bug this guards against: `de.jobsyn.org/<id>` stores its id lowercase
 * and 36 characters long (32-character job GUID + 4-character site id, no
 * separator) -- CareerForce's own stored URL looks exactly like this. The
 * microsites JSON endpoint is case-sensitive (the lowercase form of a real
 * key 404s, verified live) and keyed on only the first 32 characters. A slice
 * that assumed the input was already 32 characters, or forgot to uppercase,
 * would build a URL that 404s every time.
 */
test('extractDejobsShortlinkId slices a lowercase 36-character id down to an uppercase 32-character key', () => {
  assert.equal(
    extractDejobsShortlinkId('https://de.jobsyn.org/df45a9ad1dd44b93828029a551e97c078003'),
    'DF45A9AD1DD44B93828029A551E97C07',
  );
});

test('extractDejobsShortlinkId accepts a bare 32-character id with no trailing site id', () => {
  assert.equal(
    extractDejobsShortlinkId('https://de.jobsyn.org/df45a9ad1dd44b93828029a551e97c07'),
    'DF45A9AD1DD44B93828029A551E97C07',
  );
});

test('extractDejobsShortlinkId returns null once the URL has more than one path segment', () => {
  // That shape belongs to `extractDejobsJobId` -- an already-resolved detail
  // page, not the short link this function derives a key from directly.
  assert.equal(
    extractDejobsShortlinkId('https://homedepot.dejobs.org/DF45A9AD1DD44B93828029A551E97C07/job/?vs=8003'),
    null,
  );
  assert.equal(extractDejobsShortlinkId('not a url'), null);
});

const REAL_DEJOBS_JSON_PAYLOAD = {
  description: 'Job Description\n  \n\n  \n**Sales Specialist**\n  \n\n  \n+ Help customers plan their project.',
  html_description: '<p>Job Description</p><p><strong>Sales Specialist</strong></p>',
  title: 'Sales Specialist',
  company: 'Home Depot',
  city: 'Minneapolis',
  state_short: 'MN',
};

test('parseDejobsJson prefers the plain description, cleaned of Markdown and HTML alike', () => {
  const parsed = parseDejobsJson(REAL_DEJOBS_JSON_PAYLOAD);
  assert.ok(parsed);
  assert.match(parsed!.text, /- Help customers plan their project/);
  assert.equal(parsed!.text.includes('**'), false);
});

test('parseDejobsJson falls back to html_description only when the plain field is empty', () => {
  const parsed = parseDejobsJson({ ...REAL_DEJOBS_JSON_PAYLOAD, description: '' });
  assert.ok(parsed);
  assert.match(parsed!.text, /Job Description/);
  assert.match(parsed!.text, /Sales Specialist/);
  // html_description has no Markdown syntax to strip; cleanHtmlText alone applies.
  assert.equal(parsed!.text.includes('<p>'), false);
});

test('parseDejobsJson carries company and a "City, ST" location for the caller to correct stored values with', () => {
  const parsed = parseDejobsJson(REAL_DEJOBS_JSON_PAYLOAD);
  assert.equal(parsed!.company, 'Home Depot');
  assert.equal(parsed!.location, 'Minneapolis, MN');
});

test('parseDejobsJson omits company/location when the JSON does not carry them', () => {
  const parsed = parseDejobsJson({ description: REAL_DEJOBS_JSON_PAYLOAD.description });
  assert.equal(parsed!.company, undefined);
  assert.equal(parsed!.location, undefined);
});

test('parseDejobsJson returns null when both description fields are empty', () => {
  assert.equal(parseDejobsJson({ description: '', html_description: '' }), null);
  assert.equal(parseDejobsJson(null), null);
});
