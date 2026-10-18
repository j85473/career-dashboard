import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBrowserAtsListingTitle } from '../../src/lib/browserAtsListingFilter';
import { passesPreFilter, passesTitlePreFilter } from '../../src/lib/jobFiltering';

test('listing preview measures existing exclusions and never skips collection', () => {
  assert.deepEqual(previewBrowserAtsListingTitle({ title: 'Registered Nurse', titleComplete: true }), {
    mode: 'preview', shouldSkip: false, wouldSkip: true, titleTrust: 'usable',
    reason: 'Healthcare/Clinical role rejected',
  });
  const commercial = previewBrowserAtsListingTitle({ title: 'Clinical Sales Manager', titleComplete: true });
  assert.equal(commercial.wouldSkip, false);
  assert.equal(commercial.reason, null);
  assert.equal(commercial.shouldSkip, false);
  assert.equal(previewBrowserAtsListingTitle({ title: 'Software Engineer', titleComplete: true }).reason, 'Software Engineering role rejected');
  assert.equal(previewBrowserAtsListingTitle({ title: 'Administrative Assistant', titleComplete: true }).reason, 'Administrative role rejected');
});

test('generic and missing listing labels cannot stand in for job titles', () => {
  for (const title of [undefined, null, '', '  ', 'Apply', 'Apply now', 'View details', 'View Registered Nurse', 'Read more', 'Unknown Title', 'Title', 'Job', 'Apply for Registered Nurse', 'Registered Nurse Apply Now']) {
    const result = previewBrowserAtsListingTitle({ title, titleComplete: true });
    assert.equal(result.wouldSkip, false, String(title));
    assert.equal(result.shouldSkip, false, String(title));
    assert.equal(result.reason, null, String(title));
    assert.notEqual(result.titleTrust, 'usable', String(title));
  }
});

test('clipped, incomplete and uncertain listing titles retain their detail visit', () => {
  for (const title of ['Software Engineer...', 'Registered Nurse…', 'Registered Nurse -', 'Registered Nurse and', 'Registered Nurse (', 'Registered Nurse]']) {
    const result = previewBrowserAtsListingTitle({ title, titleComplete: true });
    assert.equal(result.titleTrust, 'incomplete', title);
    assert.equal(result.wouldSkip, false, title);
    assert.equal(result.shouldSkip, false, title);
  }
  assert.equal(previewBrowserAtsListingTitle({ title: 'Registered Nurse' }).wouldSkip, false);
  assert.equal(previewBrowserAtsListingTitle({ title: 'Registered Nurse', titleComplete: false }).wouldSkip, false);
  assert.equal(previewBrowserAtsListingTitle({ title: 'Nurse', titleComplete: true }).wouldSkip, true);
  assert.equal(previewBrowserAtsListingTitle({ title: 'Registered Nurse (RN)', titleComplete: true }).wouldSkip, true);
});

test('title preview does not invent missing employer, location, or language evidence', () => {
  assert.equal(previewBrowserAtsListingTitle({ title: 'Account Manager - London', titleComplete: true }).wouldSkip, false);
  assert.equal(previewBrowserAtsListingTitle({ title: 'Directeur commercial', titleComplete: true }).wouldSkip, false);
  assert.equal(passesTitlePreFilter('Directeur commercial').passes, true);
  assert.equal(passesPreFilter({ title: 'Directeur commercial', company: 'Example', location: '', description: '', url: '' }).passes, false);
});

test('full prefilter retains employer and description-language precedence over shared title rules', () => {
  const base = { title: 'Registered Nurse', company: 'Example', location: '', description: '', url: '' };
  assert.deepEqual(passesPreFilter({ ...base, company: '' }), { passes: false, reason: 'Missing title or company' });
  assert.deepEqual(passesPreFilter({ ...base, description: 'Nous sommes une équipe et vous serez dans notre équipe avec des responsabilités pour votre travail.' }), {
    passes: false, reason: 'Available job information is not in English.',
  });
  assert.deepEqual(passesPreFilter(base), { passes: false, reason: 'Healthcare/Clinical role rejected' });
});
