import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cleanJobDescriptionPage } from '../jobDescriptionCleanup';
import { cleanHtmlText } from '../jobIngestion';
import { assessJobDescriptionQuality, isClosedJobPosting } from '../jobDescriptionQuality';
import { presentJobDescription } from '../jobDescriptionPresentation';
import { decideJdRecovery } from '../jdRecoveryPolicy';
import { postingRefreshDescription } from '../postingMetadata';

const page = readFileSync('tests/fixtures/job-descriptions/trabajo-toshiba.txt', 'utf8');
const expected = 'Toshiba International Corporation is seeking a Regional Sales Manager to drive growth in an assigned district. You will lead and coach sales staff, coordinate with marketing, engineering, and service teams, and manage key accounts to expand market share.\n\nTravel up to 60% across the region is expected; a proven sales record and at least three years of experience are required. The role reports to the Regional Sales Manager and offers growth opportunities.';

test('the captured Toshiba page retains only its exact two posting paragraphs', () => {
  assert.equal(cleanJobDescriptionPage(page), expected);
  assert.equal(cleanHtmlText(page), expected);
  assert.equal(cleanJobDescriptionPage(expected), expected);
});

test('navigation and other employers cannot inflate a short summary past the JD gate', () => {
  for (const structuredSource of [false, true]) {
    const quality = assessJobDescriptionQuality(page, { structuredSource });
    assert.equal(quality.scorable, false);
    assert.equal(quality.reason, 'fewer than 650 usable characters');
  }
  assert.equal(decideJdRecovery(page, 0).kind, 'retry');
  assert.equal(isClosedJobPosting(page), false);
});

test('a complete posting is accepted and returned without unrelated page content', () => {
  const full = `${expected}\n\nResponsibilities\n${'Manage partner accounts and coordinate sales plans. '.repeat(15)}\nRequirements\nAt least three years of sales experience.`;
  const completePage = page.replace(expected, full);
  const decision = decideJdRecovery(completePage, 0);
  assert.equal(decision.kind, 'ready');
  if (decision.kind === 'ready') assert.equal(decision.text, full);
  assert.deepEqual(postingRefreshDescription({ description: completePage, structuredSource: false,
    existingDescription: '', preserveScores: false, metadata: {} }), { description: full, verified: true });
});

test('closure language in recommendations does not expire the primary posting', () => {
  const unrelatedClosure = page.replace('AMETEK, Inc. is seeking', 'This position is filled. AMETEK, Inc. is seeking');
  assert.equal(isClosedJobPosting(unrelatedClosure), false);
  assert.equal(decideJdRecovery(unrelatedClosure, 0).kind, 'retry');
  assert.equal(decideJdRecovery(page.replace(expected, 'This position is no longer available.'), 0).kind, 'closed');
});

test('cleaning retains reader 404 evidence while excluding unrelated recommendations', () => {
  const missingPage = page.replace('Markdown Content:', 'Warning: Target URL returned error 404: Not Found\n\nMarkdown Content:');
  assert.equal(isClosedJobPosting(missingPage), true);
  assert.equal(decideJdRecovery(missingPage, 0).kind, 'closed');
  assert.equal(isClosedJobPosting(cleanHtmlText(missingPage)), true);
});

test('unknown Trabajo layouts remain intact and cannot masquerade as complete JDs', () => {
  for (const broken of [page.replace('# Strategic Regional Sales Leader', 'Strategic Regional Sales Leader'),
    page.replace('Full-time', 'Unknown employment type'),
    page.replace('Save jobSave and create alert', 'Changed account form')]) {
    assert.equal(cleanJobDescriptionPage(broken), broken);
    assert.equal(assessJobDescriptionQuality(broken).scorable, false);
  }
});

test('observed account-panel variants and metadata pay retain all posting evidence', () => {
  const withoutTerms = page.replace('By continuing, you agree to our Terms&Privacy Policy.\n\n', '');
  assert.equal(cleanJobDescriptionPage(withoutTerms), expected);
  assert.equal(cleanJobDescriptionPage(page.replace('Full-time', 'Full-time $70,000 - $100,000')),
    `${expected}\n\n$70,000 - $100,000`);
});

test('plain text, other providers, and authored headings are preserved', () => {
  for (const text of [expected, '## Duties\nTravel <10%.\n\n## Requirements\nExperience required.',
    page.replaceAll('trabajo.org', 'example.test')]) assert.equal(cleanJobDescriptionPage(text), text);
});

test('older cards display the clean posting without changing scores or lifecycle', () => {
  const job = Object.freeze({ description: page, status: 'applied', aimFitScore: 63, reqFitScore: 84,
    scoreHistory: Object.freeze([{ id: 'preserved' }]) });
  const presented = presentJobDescription(job);
  assert.deepEqual(presented, { ...job, description: expected });
  assert.equal(job.description, page);
  assert.equal(presented.scoreHistory, job.scoreHistory);
});
