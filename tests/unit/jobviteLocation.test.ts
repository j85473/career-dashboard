import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserPosting } from '../../src/lib/browserAtsPosting';
import { jobviteHeaderLocation, jobvitePublishedLocation, recoverableJobviteLocation } from '../../src/lib/jobviteLocation';

const url = 'https://jobs.jobvite.com/meltwater/job/oSgnAfwP';
const description = 'Manage customer adoption, retention, onboarding, and operating reviews. '.repeat(8);
const detail = (meta: string) => `<title>Meltwater Careers - Customer Success Manager</title>
  <h2>Customer Success Manager</h2><p class="jv-job-detail-meta">${meta}</p>
  <a href="/meltwater/job/oSgnAfwP/apply">Apply</a>
  <div class="jv-job-detail-description">${description}</div>`;

test('Jobvite parser recovers Toronto hybrid metadata without including Sales', () => {
  const html = detail('Sales<span class="jv-inline-separator"></span>Hybrid Remote<span>,</span>\n Toronto,\n ON');
  const posting = parseBrowserPosting('jobvite', 'https://jobs.jobvite.com/meltwater/jobs',
    { id: 'oSgnAfwP', url, title: 'Customer Success Manager' }, [{ url, html, text: description }]);
  assert.equal(posting?.location, 'Hybrid Remote, Toronto, ON');
});

test('Jobvite header handles location-only and multi-location employer templates', () => {
  assert.equal(jobviteHeaderLocation(detail('\n Newport,\n Oregon')), 'Newport, Oregon');
  assert.equal(jobviteHeaderLocation(detail('Architecture<span class="jv-inline-separator"></span>Charlotte, North Carolina')), 'Charlotte, North Carolina');
  assert.equal(jobviteHeaderLocation(detail('Customer Support<span class="jv-inline-separator"></span>Austin, Texas<span class="jv-inline-separator"></span>Houston, Texas<span class="jv-inline-separator"></span>Remote, United States')), 'Austin, Texas; Houston, Texas; Remote, United States');
});

test('Jobvite missing, unresolved, and department-only headers do not invent geography', () => {
  for (const meta of ['', 'Analytics', "Hope's Closet", 'Sales<span class="jv-inline-separator"></span>', '{{ job.location }}', 'Multiple Locations']) {
    assert.equal(jobviteHeaderLocation(detail(meta)), '');
  }
  assert.equal(jobviteHeaderLocation('<footer>Toronto, ON</footer>'), '');
});

test('Jobvite strips salary, closing dates, and requisition labels from header locations', () => {
  assert.equal(jobviteHeaderLocation(detail('IT<span class="jv-inline-separator"></span>Oakland, California<br>Salary: USD 95721 - 145496 Annually')), 'Oakland, California');
  assert.equal(jobviteHeaderLocation(detail('Careers<span class="jv-inline-separator"></span>Dubuque, Iowa<br>Posting Closes: 10/29/2026')), 'Dubuque, Iowa');
  assert.equal(jobviteHeaderLocation(detail('Insurance<span class="jv-inline-separator"></span>Brampton, Ontario<span class="jv-inline-separator"></span>#2025-10934 (reqID)')), 'Brampton, Ontario');
});

test('Jobvite reads labeled snapshot locations once across desktop and mobile copies', () => {
  const snapshot = '<li class="snapshot-item location"><span class="fa-li">icon</span><p>Location:</p><p>Duluth, Georgia</p></li>';
  assert.equal(jobviteHeaderLocation(snapshot.repeat(2)), 'Duluth, Georgia');
  const multiple = '<li class="snapshot-item location"><p>Location:</p><p></p><p>Toronto, Canada</p><p>British Columbia, Canada</p><p></p></li>';
  assert.equal(jobviteHeaderLocation(multiple.repeat(2)), 'Toronto, Canada; British Columbia, Canada');
});

test('Jobvite recovers country-only structured geography despite invalid apostrophe escaping', () => {
  const html = detail("Hope's Closet") + '<script type="application/ld+json">'
    + JSON.stringify({ '@type': 'JobPosting', identifier: 'oSgnAfwP', industry: "Hope's Closet", jobLocation: [{ address: { addressCountry: 'United States' } }] }).replace("Hope's", "Hope\\'s")
    + '</script>';
  assert.equal(jobvitePublishedLocation(html, url), 'United States');
  assert.equal(jobvitePublishedLocation(html, url.replace('oSgnAfwP', 'other')), '');
});

test('Jobvite fallback leaves complete structured multi-location metadata authoritative', () => {
  const html = detail('Sales<span class="jv-inline-separator"></span>Toronto, ON')
    + `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: 'Customer Success Manager', hiringOrganization: { name: 'Meltwater' }, description,
      jobLocation: [{ address: { addressLocality: 'Toronto', addressRegion: 'ON', addressCountry: 'Canada' } }, { address: { addressLocality: 'Minneapolis', addressRegion: 'MN', addressCountry: 'US' } }] })}</script>`;
  const posting = parseBrowserPosting('jobvite', 'https://jobs.jobvite.com/meltwater/jobs',
    { id: 'oSgnAfwP', url, title: 'Customer Success Manager' }, [{ url, html, text: description }]);
  assert.equal(posting?.location, 'Toronto, ON, Canada; Minneapolis, MN, US');
});

test('recovery rejects closed redirects and other requisitions even when a location is present', () => {
  const html = detail('Sales<span class="jv-inline-separator"></span>Toronto, ON');
  assert.equal(recoverableJobviteLocation(html, url, url), 'Toronto, ON');
  assert.equal(recoverableJobviteLocation(html, url, 'https://jobs.jobvite.com/meltwater/jobs'), '');
  assert.equal(recoverableJobviteLocation(html, url, url.replace('oSgnAfwP', 'other')), '');
  assert.equal(recoverableJobviteLocation(html.replace('/oSgnAfwP/apply', '/other/apply'), url, url), '');
  assert.equal(recoverableJobviteLocation(html, url.replace('https:', 'http:'), url), '');
});
