import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompanyLogo } from '../../components/CompanyLogo';
import JobCard from '../../components/JobCard';
import type { JobListItem } from '../../types/job';
import { companyLogoDomain, companyLogoInitials, companyLogoUrl } from '../companyLogo';

test('LexisNexis Risk Solutions uses its verified subdomain even on a shared RELX board', () => {
  const url = 'https://relx.wd3.myworkdayjobs.com/en-US/risksolutions/job/Remote---USA---Nationwide/Strategic-Account-Manager_R119269';
  for (const company of ['LexisNexis Risk Solutions', 'LexisNexis Risk Solutions FL Inc. Company']) {
    assert.equal(companyLogoDomain({ company, url }), 'risk.lexisnexis.com');
  }
  assert.equal(companyLogoDomain({ company: 'LexisNexis' }), 'lexisnexis.com');
  assert.equal(companyLogoDomain({ company: 'LexisNexis Risk Solutions Consulting', url }), null);
});

test('reviewed non-com website avoids the previous Catchafire wrong-company lookup', () => {
  assert.equal(companyLogoDomain({ company: 'Catchafire, Inc.' }), 'catchafire.org');
  assert.equal(companyLogoDomain({ company: 'Catchafire Consulting' }), null);
});

test('unreviewed employers need an actual matching posting domain', () => {
  assert.equal(companyLogoUrl({ company: 'Acme' }), null);
  for (const url of ['https://acme.org/jobs/42', 'https://careers.acme.org/42', 'https://www.jobs.acme.org/42']) {
    assert.equal(companyLogoDomain({ company: 'Acme, Inc.', url }), 'acme.org');
  }
  assert.equal(companyLogoDomain({ company: 'Acme UK', url: 'https://jobs.acme-uk.co.uk/42' }), 'acme-uk.co.uk');
});

test('ATS tenants, reposters, unrelated brands and misleading subdomains cannot supply a logo', () => {
  for (const url of [
    'https://acme.myworkdayjobs.com/jobs/42', 'https://jobs.lever.co/acme/42',
    'https://boards.greenhouse.io/acme/jobs/42', 'https://careers.kula.ai/acme/42',
    'https://www.linkedin.com/company/acme', 'https://acme.evil.com/jobs/42',
    'https://careers.acme.example.com/42', 'https://acmeinc.com/42',
    'https://acme.com.evil.org/42', 'https://acme.com@evil.org/42',
    'https://acme.com:3000/42', 'http://127.0.0.1/42', 'javascript:alert(1)',
    'https://unrelated.com/acme',
  ]) assert.equal(companyLogoDomain({ company: 'Acme', url }), null, url);
  assert.equal(companyLogoDomain({ company: null, url: 'https://acme.com/42' }), null);
});

test('contradictory source domains fall back to initials', () => {
  assert.equal(companyLogoDomain({ company: 'Acme', url: 'https://acme.com/42', canonicalUrl: 'https://acme.org/42' }), null);
});

test('company mark renders a verified logo or initials without making an invented request', () => {
  const verified = renderToStaticMarkup(React.createElement(CompanyLogo, { company: 'LexisNexis Risk Solutions' }));
  assert.match(verified, /domain=risk.lexisnexis.com/);
  const unknown = renderToStaticMarkup(React.createElement(CompanyLogo, { company: 'Unknown Employer' }));
  assert.ok(!unknown.includes('<img'));
  assert.match(unknown, />UE<\/span>/);
  assert.equal(companyLogoInitials(''), '?');
});

test('job cards resolve branding from the displayed employer without mutating saved job evidence', () => {
  const job = Object.freeze({
    id: '7c5e9866-df7c-4bce-a405-f58623118089', title: 'Strategic Account Manager',
    company: 'LexisNexis Risk Solutions FL Inc. Company', employer: 'LexisNexis Risk Solutions',
    status: 'pending_af', source: 'ATS-workday',
    url: 'https://relx.wd3.myworkdayjobs.com/en-US/risksolutions/job/42',
    aimFitScore: 82, reqFitScore: 86, scoreAuthorityState: 'current',
  } satisfies JobListItem);
  const before = JSON.stringify(job);
  const html = renderToStaticMarkup(React.createElement(JobCard, { job, onSelect: () => {} }));
  assert.match(html, /domain=risk.lexisnexis.com/);
  assert.ok(!html.includes('lexisnexisrisksolutions.com'));
  assert.equal(JSON.stringify(job), before);

  const otherEmployer = renderToStaticMarkup(React.createElement(JobCard, {
    job: { ...job, employer: 'Different Employer' }, onSelect: () => {},
  }));
  assert.ok(!otherEmployer.includes('<img'), 'a raw source label must not override the resolved employer');
});
