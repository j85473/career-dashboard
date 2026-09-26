import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gustoBoardIdFromSlug,
  gustoBoardSlugFromUrl,
  gustoPostingIdFromUrl,
  parseGustoBoardHtml,
  parseGustoPostingHtml,
} from '../gustoBoard';

const boardSlug = 'we-scale-local-8a03dcec-c77a-4fa0-a9fe-438a688b7c6c';
const postingUrl = 'https://jobs.gusto.com/postings/we-scale-local-account-manager-sammie-e4a7e88d-ae10-4953-b50c-8bd8dee39a44';

test('Gusto discovery accepts exact board links and rejects posting and vendor paths', () => {
  assert.equal(gustoBoardSlugFromUrl(`https://jobs.gusto.com/boards/${boardSlug}?source=careers`), boardSlug);
  assert.equal(gustoBoardIdFromSlug(boardSlug), '8a03dcec-c77a-4fa0-a9fe-438a688b7c6c');
  assert.equal(gustoPostingIdFromUrl(postingUrl), 'e4a7e88d-ae10-4953-b50c-8bd8dee39a44');
  for (const url of [postingUrl, 'https://gusto.com/boards/example-8a03dcec-c77a-4fa0-a9fe-438a688b7c6c', 'https://jobs.gusto.com/boards/', 'https://jobs.gusto.com/boards/bad']) {
    assert.equal(gustoBoardSlugFromUrl(url), null, url);
  }
});

test('Gusto board extraction requires a rendered employer header and a position list', () => {
  const board = parseGustoBoardHtml(`<div class="job-board-header"><h1>We Scale Local</h1></div>
    <h1>Open Positions</h1><a href="/postings/we-scale-local-account-manager-sammie-e4a7e88d-ae10-4953-b50c-8bd8dee39a44">
    <h3>Account Manager (Sammie)</h3><p>Remote</p><p>Part time</p></a>`, boardSlug);
  assert.equal(board?.company, 'We Scale Local');
  assert.deepEqual(board?.postings, [{
    id: 'e4a7e88d-ae10-4953-b50c-8bd8dee39a44',
    title: 'Account Manager (Sammie)',
    location: 'Remote',
    url: postingUrl,
  }]);
  assert.equal(parseGustoBoardHtml('<h1>Oh no! We cannot find this page</h1>', boardSlug), null);
});

test('Gusto posting extraction requires the same board and a description', () => {
  const html = `<a href="/boards/${boardSlug}">Careers at We Scale Local</a>
    <h1><span>We Scale Local</span><span>Account Manager (Sammie)</span><span>Remote · Part time</span></h1>
    <h3>Description</h3><div class="rich-text-container"><h2>Job Overview</h2><p>Own onboarding and retention.</p></div>
    <h4>Salary</h4><p>$20 - $25 per hour</p>`;
  const posting = parseGustoPostingHtml(html, postingUrl, boardSlug);
  assert.equal(posting?.id, 'e4a7e88d-ae10-4953-b50c-8bd8dee39a44');
  assert.equal(posting?.location, 'Remote');
  assert.match(posting?.description || '', /Own onboarding and retention/);
  assert.match(posting?.description || '', /Salary: \$20 - \$25 per hour/);
  assert.equal(parseGustoPostingHtml(html.replace(boardSlug, 'other-8a03dcec-c77a-4fa0-a9fe-438a688b7c6d'), postingUrl, boardSlug), null);
  assert.equal(parseGustoPostingHtml('<h1>404 Error</h1>', postingUrl, boardSlug), null);
});
