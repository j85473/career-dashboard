import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPostingLink, parseBrowserPosting } from '../../src/lib/browserAtsPosting';

const board = 'https://manpower.taleo.net/careersection/direct_apply_url/jobsearch.ftl';
const link = browserPostingLink('taleo', board, board.replace('jobsearch.ftl', 'jobdetail.ftl?job=0034809'), 'Business Development Manager, IT')!;
const body = 'Build your career with Experis, a ManpowerGroup company. '.repeat(5)
  + 'ManpowerGroup is proud to be an equal opportunity affirmative action workplace.';
// Reduced from requisition 0034809. IDs deliberately differ from production:
// generated numeric IDs must never become the field's identity.
const row = (id: string, label: string, value: string) => `<div class="contentlinepanel" id="requisitionDescriptionInterface.${id}.row1">${label ? `<h2><span class="subtitle">${label}</span></h2><span class="subtitle">:</span>` : ''}<span class="text">${value}</span></div>`;
const html = row('title', '', `<span id="requisitionDescriptionInterface.reqTitleLinkAction.row1">${link.title}</span><span id="requisitionDescriptionInterface.reqContestNumberValue.row1">0034809</span>`)
  + row('primary', '', 'US-CA-Sacramento') + row('mode', 'Worker Location', 'Hybrid')
  + row('description', 'Description', body) + row('organization', 'Organization', 'ManpowerGroup');
const parse = (content = html, url = link.url) => parseBrowserPosting('taleo', board, link, [{ url, html: content, text: body }]);

test('Taleo reads an unlabeled primary location, work arrangement and corroborated Organization', () => {
  const job = parse()!;
  assert.equal(job.company, 'ManpowerGroup');
  assert.equal(job.location, 'US-CA-Sacramento; Hybrid');
  assert.equal(job.id, '0034809');
  assert.equal(job.title, link.title);
});

test('Taleo preserves labeled primary and additional locations without salary or travel fields', () => {
  const content = html.replace(row('primary', '', 'US-CA-Sacramento'), row('primary', 'Primary Location', 'US-CA-Sacramento'))
    + row('other', 'Other Locations', 'US-MN-Minneapolis') + row('travel', 'Travel', '20%') + row('salary', 'Potential Salary Range', '52500-87500');
  assert.equal(parse(content)?.location, 'US-CA-Sacramento; US-MN-Minneapolis; Hybrid');
});

test('Taleo rejects mismatched requisitions, foreign documents and uncorroborated or conflicting organizations', () => {
  assert.equal(parse(html.replace('>0034809<', '>0034810<')), null);
  assert.equal(parse(html, link.url.replace('manpower.taleo.net', 'other.taleo.net')), null);
  for (const content of [html.replace(body, body.replace('ManpowerGroup is proud', 'Our company is proud')),
    html.replace(row('organization', 'Organization', 'ManpowerGroup'), row('organization', 'Organization', 'Sales')),
    html + row('conflict', 'Organization', 'Other Employer')]) {
    assert.equal(parse(content)?.company, 'Unknown Company');
  }
});

test('Taleo never treats unrelated page rows or description mentions as header geography', () => {
  const content = html.replace(row('primary', '', 'US-CA-Sacramento'), '')
    + row('later', '', 'US-TX-Austin') + '<div class="contentlinepanel"><span class="subtitle">Primary Location</span><span class="text">US-NY-New York</span></div>';
  assert.equal(parse(content)?.location, 'Hybrid');
});
