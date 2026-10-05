import assert from 'node:assert/strict';
import test from 'node:test';
import { readRenderedGustoPage } from '../gustoBrowserPage';
import { parseGustoBoardSnapshot, parseGustoPostingHtml } from '../gustoBoard';

const slug = 'example-8a03dcec-c77a-4fa0-a9fe-438a688b7c6c';
const postingUrl = 'https://jobs.gusto.com/postings/example-e4a7e88d-ae10-4953-b50c-8bd8dee39a44';
function pageWith(html: string, text = '') {
  return { content: async () => html, locator: () => ({ innerText: async () => text }) };
}

test('rendered setup pages return immediately rather than waiting for missing headings', async () => {
  const page = pageWith('<p>Setup</p>', 'Just a few more steps to go. This account is still being set up.');
  const result = await readRenderedGustoPage(page, (html, text) => parseGustoBoardSnapshot(html, text, slug), 'Board', 5);
  assert.equal(result.unavailableReason, 'setup');
});

test('provider details with two Description headings complete without locator ambiguity', async () => {
  const page = pageWith(`<a href="/boards/${slug}">Careers</a><h1><span>Example</span><span>Account Manager</span></h1>
    <section><h3>Description</h3><div data-controller="rich-text"><div class="rich-text-container"><h2>Description</h2><p>Enable distributors.</p></div></div></section>`);
  const result = await readRenderedGustoPage(page, (html) => parseGustoPostingHtml(html, postingUrl, slug), 'Posting', 5);
  assert.match(result.description, /Enable distributors/);
});

test('challenges and unrelated pages cannot become successful empty inventory', async () => {
  const page = pageWith('<h1>Just a moment...</h1>', 'Just a moment...');
  await assert.rejects(readRenderedGustoPage(page, (html, text) => parseGustoBoardSnapshot(html, text, slug), 'Board', 5), /did not render verified Gusto inventory/);
});

test('Gusto soft 404 pages become immediate not-found failures instead of render timeouts', async () => {
  const page = pageWith('<h1>404 Error</h1>', "404 ERROR Oh no! We can't find the page you're looking for.");
  await assert.rejects(readRenderedGustoPage(page, (html, text) => parseGustoBoardSnapshot(html, text, slug), 'Board', 5), /HTTP 404/);
});
