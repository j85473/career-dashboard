import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gustoBoardIdFromSlug,
  gustoBoardSlugFromUrl,
  gustoPostingIdFromUrl,
  isGustoClosedBoardPage,
  parseGustoBoardHtml,
  parseGustoPostingHtml,
  parseGustoReaderMarkdown,
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

test('Gusto board extraction accepts the live centered employer heading and a position list', () => {
  const board = parseGustoBoardHtml(`<div class="text-center"><div class="mb-8"><img src="/logo"></div>
    <h1 class="mt-1 text-4xl font-extrabold">We Scale Local</h1><p>Growth agency</p></div>
    <h1 class="font-semibold">Open Positions</h1><a href="/postings/we-scale-local-account-manager-sammie-e4a7e88d-ae10-4953-b50c-8bd8dee39a44">
    <h3>Account Manager (Sammie)</h3><p>Remote</p><p>Part time</p></a>`, boardSlug);
  assert.equal(board?.company, 'We Scale Local');
  assert.deepEqual(board?.postings, [{
    id: 'e4a7e88d-ae10-4953-b50c-8bd8dee39a44',
    title: 'Account Manager (Sammie)',
    location: 'Remote',
    url: postingUrl,
  }]);
  assert.equal(parseGustoBoardHtml('<h1>Oh no! We cannot find this page</h1>', boardSlug), null);
  assert.equal(parseGustoBoardHtml('<h1>Open Positions</h1>', boardSlug), null);
});

test('Gusto board extraction treats an explicit no-open-positions page as a valid empty sweep', () => {
  const board = parseGustoBoardHtml(`<div class="text-center"><h1>Genesis Garden</h1>
    <p>To be added</p></div><h3>There are no open positions currently</h3>`, boardSlug);
  assert.deepEqual(board, { company: 'Genesis Garden', postings: [] });
  assert.equal(parseGustoBoardHtml('<h1>Genesis Garden</h1><h3>Something went wrong</h3>', boardSlug), null);
});

test('Gusto closed-board marker is explicit and cannot conceal posting links', () => {
  const visibleText = 'This job board is closed.\nYour Privacy Choices\nRead our Privacy Policy';
  assert.equal(isGustoClosedBoardPage(visibleText, false), true);
  assert.equal(isGustoClosedBoardPage('Just a moment...', false), false);
  assert.equal(isGustoClosedBoardPage(`Finish Setup\n${visibleText}`, false), false);
  assert.equal(isGustoClosedBoardPage(visibleText, true), false);
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
  assert.doesNotMatch(posting?.description || '', /<h2>|<p>/);
  assert.match(posting?.description || '', /Salary: \$20 - \$25 per hour/);
  assert.equal(parseGustoPostingHtml(html.replace(boardSlug, 'other-8a03dcec-c77a-4fa0-a9fe-438a688b7c6d'), postingUrl, boardSlug), null);
  assert.equal(parseGustoPostingHtml('<h1>404 Error</h1>', postingUrl, boardSlug), null);
});

test('Gusto reader fallback keeps the exact posting identity, company, and readable sections', () => {
  const markdown = `Title: Account Manager (Sammie) at We Scale Local\n\nURL Source: ${postingUrl}\n\nMarkdown Content:\n**The Role**\n\nOwn onboarding and retention.\n\n**What You'll Do**\n\n*   Build partner plans.\n*   Review results.`;
  assert.deepEqual(parseGustoReaderMarkdown(markdown, postingUrl), {
    title: 'Account Manager (Sammie)',
    company: 'We Scale Local',
    description: "The Role\n\nOwn onboarding and retention.\n\nWhat You'll Do\n\n• Build partner plans.\n• Review results.",
  });
  assert.equal(parseGustoReaderMarkdown(markdown, postingUrl.replace('e4a7e88d', 'e4a7e88e')), null);
});
