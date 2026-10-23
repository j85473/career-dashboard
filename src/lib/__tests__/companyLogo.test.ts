import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
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

test('company mark renders verified branding or requests evidence recovery with initials underneath', () => {
  const verified = renderToStaticMarkup(React.createElement(CompanyLogo, { company: 'LexisNexis Risk Solutions' }));
  const verifiedLogo = new URL(load(verified)('img').attr('src')!, 'https://dashboard.test');
  assert.equal(verifiedLogo.origin, 'https://dashboard.test');
  assert.equal(verifiedLogo.pathname, '/api/company-logo');
  assert.equal(verifiedLogo.searchParams.get('company'), 'LexisNexis Risk Solutions');
  const unknown = renderToStaticMarkup(React.createElement(CompanyLogo, { company: 'Unknown Employer' }));
  const lookup = new URL(load(unknown)('img').attr('src')!, 'https://dashboard.test');
  assert.equal(lookup.origin, 'https://dashboard.test');
  assert.equal(lookup.pathname, '/api/company-logo');
  assert.equal(lookup.searchParams.get('company'), 'Unknown Employer');
  assert.equal(lookup.searchParams.get('v'), '3');
  assert.equal(lookup.searchParams.get('domain'), null);
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
  const images = load(html)('img');
  assert.equal(images.length, 1);
  const logo = new URL(images.attr('src')!, 'https://dashboard.test');
  assert.equal(logo.hostname, 'dashboard.test');
  assert.equal(logo.pathname, '/api/company-logo');
  assert.equal(logo.searchParams.get('company'), 'LexisNexis Risk Solutions');
  assert.equal(logo.searchParams.get('jobId'), job.id);
  assert.equal(JSON.stringify(job), before);

  const otherEmployer = renderToStaticMarkup(React.createElement(JobCard, {
    job: { ...job, employer: 'Different Employer' }, onSelect: () => {},
  }));
  const otherLookup = new URL(load(otherEmployer)('img').attr('src')!, 'https://dashboard.test');
  assert.equal(otherLookup.origin, 'https://dashboard.test');
  assert.equal(otherLookup.pathname, '/api/company-logo');
  assert.equal(otherLookup.searchParams.get('jobId'), job.id);
  assert.equal(otherLookup.searchParams.get('domain'), null, 'a raw source label must not override the resolved employer');
});
