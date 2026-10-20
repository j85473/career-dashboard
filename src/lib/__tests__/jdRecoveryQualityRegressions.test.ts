import assert from 'node:assert/strict';
import test from 'node:test';
import { assessJobDescriptionQuality, isClosedJobPosting, storedDescriptionQualityOptions } from '../jobDescriptionQuality';
import { decideJdRecovery, planJdRecoveryReconciliation } from '../jdRecoveryPolicy';
import { classifyTerminalJdFailure } from '../jdTerminalDisposition';
import { hasAuthoritativeMetadata } from '../authoritativeMetadataGate';
import { preferredPostingDescriptionUrl } from '../jobSourceProvenance';
import { jdRecoveryAttemptEvidence, readJdRecoveryResponse } from '../jdRecoveryEvidence';

const construction = [
  'Construction Crew Leader',
  'What will you do?',
  'Assist with demolition, site preparation, framing, insulation, drywall, flooring, roofing, finish carpentry and landscaping.',
  'Lead small groups of volunteers on a safe building site. Projects include new construction, rehabilitation, critical home repairs and weatherization.',
  'Minimum Requirements',
  'Applicants must be at least 18, have a high school diploma or GED, and demonstrate clear communication and teamwork.',
  'Members serve full time and in person, normally Tuesday through Saturday, with training and guidance from experienced construction staff.',
  'Benefits include a living allowance, health care coverage, personal leave, professional development and an education award after successful service.',
].join('\n');

test('real non-commercial duties plus a Search Jobs footer are not a portal shell', () => {
  const body = `${construction}\nSearch Jobs at | Example Housing\nApply\nSave\nSend to friend`;
  assert.equal(assessJobDescriptionQuality(body, { structuredSource: true }).scorable, true);
  assert.equal(decideJdRecovery(body, 2, { structuredSource: true }).kind, 'ready');
});

test('a retained complete posting with a reader target-404 is accepted without its provenance header poisoning quality', () => {
  const body = `${construction}\n${construction}\nSearch Jobs at | Example Housing`;
  const wrapped = `Title: Recruitment\nURL Source: https://example.com/jobs/123\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\n${body}`;
  assert.equal(isClosedJobPosting(wrapped), false);
  assert.equal(decideJdRecovery(wrapped, 2).kind, 'ready');
  assert.equal(decideJdRecovery(wrapped.replace(body, 'Similar jobs near you.'), 2).kind, 'closed');
});

test('an authored etc... at the end of a complete description is not evidence of truncation', () => {
  assert.equal(decideJdRecovery(`${construction}\nCoordinate repairs, supplies, schedules, etc...`, 2, { structuredSource: true }).kind, 'ready');
  const truncated = decideJdRecovery(`${construction}\nThe successful applicant will...`, 2, { structuredSource: true });
  assert.equal(truncated.kind, 'retry');
});

test('Himalayas and Apify description fields retain content provenance without gaining metadata authority', () => {
  const body = 'Scrum Master requires experience leading Agile teams and setting up sprints in Jira. Facilitate retrospectives, track sprint progress, and clear impediments. '.repeat(6);
  assert.equal(assessJobDescriptionQuality(body).scorable, false);
  for (const source of ['Himalayas', 'LinkedIn (Apify)', 'LinkedIn (Apify) -> ATS']) {
    assert.equal(assessJobDescriptionQuality(body, storedDescriptionQualityOptions(source)).scorable, true);
    assert.equal(hasAuthoritativeMetadata(source), false);
    assert.equal(assessJobDescriptionQuality('Brief snippet', storedDescriptionQualityOptions(source)).scorable, false);
  }
});

test('publisher-specific closure notices terminate recovery, while temporary failures stay inconclusive', () => {
  for (const text of [
    'This job cannot be viewed at this time. It has either been deleted or is no longer available for application. For more job opportunities, please click here.',
    'JazzHR - Inactive Career Page. This account is no longer active. Learn more about JazzHR.',
    'Position Closed. Sorry, this position is no longer accepting candidates.',
  ]) assert.equal(decideJdRecovery(text, 2).kind, 'closed');
  assert.equal(decideJdRecovery('This site is temporarily unavailable. Please try again later.', 2).kind, 'retry');
});

test('long access challenges remain rejected even when they mention requirements', () => {
  for (const header of [
    'Just a moment. Enable JavaScript and cookies to continue.',
    'Attention Required! Cloudflare. Sorry, you have been blocked.',
    'Human Verification. Verify that you are not a robot by solving a CAPTCHA puzzle.',
  ]) {
    const body = header + ' Your browser must meet the security requirements before you can access this page.'.repeat(35);
    assert.equal(assessJobDescriptionQuality(body, { structuredSource: true }).scorable, false);
    assert.equal(isClosedJobPosting(body), false);
  }
});

test('historical shell labels do not establish closure for blank or now-usable descriptions', () => {
  const job = { scoringStatus: 'failed', scoreError: 'JD recovery rejected: expired, closed, login, cookie, or portal shell.', passReason: null, source: 'ATS-brassring' };
  assert.equal(classifyTerminalJdFailure({ ...job, description: '' })?.disposition, 'unproven');
  assert.equal(classifyTerminalJdFailure({ ...job, description: `${construction}\nSearch Jobs at | Example` })?.cause, 'accepted_by_current_gate');
  assert.equal(planJdRecoveryReconciliation({ source: 'ATS-brassring', description: `${construction}\nSearch Jobs at | Example` }).action, 'queue_local');
  assert.equal(classifyTerminalJdFailure({ ...job, description: 'This position is no longer available.' })?.disposition, 'proven_unavailable');
});

test('BrassRing recovery retains the exact requisition when canonicalization drops its fragment', () => {
  const board = 'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=26053&siteid=5396';
  const posting = `${board}#jobDetails=859939_5396`;
  assert.equal(preferredPostingDescriptionUrl(posting, board), posting);
  assert.equal(preferredPostingDescriptionUrl('https://example.com/source', 'https://employer.com/job/123'), 'https://employer.com/job/123');
});

test('rejected-body evidence is bounded, hashed, and separate from the saved description', () => {
  const body = 'Public posting body. '.repeat(2000);
  const receipt = jdRecoveryAttemptEvidence({ url: 'https://example.com/jobs/123', transport: 'reader', responseStatus: 200, body }, 'retry', 'no usable qualifications');
  assert.equal(receipt.bodyLength, body.length);
  assert.equal(receipt.bodyExcerpt.length, 20_000);
  assert.equal(receipt.bodyExcerptTruncated, true);
  assert.match(receipt.bodySha256, /^[a-f0-9]{64}$/);
  const failedReader = jdRecoveryAttemptEvidence({ url: 'https://example.com/jobs/123', transport: 'reader', responseStatus: 429 }, 'transport_error', 'JD reader request failed: HTTP 429');
  assert.equal(failedReader.responseStatus, 429);
  assert.equal(failedReader.outcome, 'transport_error');
  assert.equal(failedReader.bodyLength, 0);
});

test('reader service failures never become empty-body quality verdicts or employer closure evidence', async () => {
  for (const status of [403, 404, 410, 429, 503]) {
    await assert.rejects(readJdRecoveryResponse(new Response('Service unavailable', { status })),
      new RegExp(`JD reader request failed: HTTP ${status}`));
  }
  const body = 'Warning: Target URL returned error 404: Not Found\n\nMarkdown Content:\nSimilar jobs';
  assert.equal(await readJdRecoveryResponse(new Response(body)), body);
});
