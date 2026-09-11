import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSourceBackedDraft,
  parseGeneratedDrafts,
  type LinkedInArticle,
} from '../../src/lib/linkedinPostGeneration';

const articles: LinkedInArticle[] = [
  {
    lane: 'SaaS Channel & Partnerships',
    title: 'Partner programs move toward measurable outcomes',
    url: 'https://example.com/channel',
    snippet: 'The report found that partners with defined launch plans reached their first transaction sooner. A second finding follows.',
  },
  {
    lane: 'B2B GTM Strategy',
    title: 'A clearer route to market',
    url: 'https://example.com/gtm',
    snippet: 'Companies are revisiting indirect routes to market as acquisition costs rise.',
  },
  {
    lane: 'Partner Operations',
    title: 'Operational data changes partner decisions',
    url: 'https://example.com/operations',
    snippet: 'The survey connects timely reporting with faster corrective action.',
  },
];

test('source-backed fallback preserves the verified article and uses its evidence', () => {
  const draft = buildSourceBackedDraft(articles[0]);

  assert.equal(draft.url, articles[0].url);
  assert.match(draft.title, /SaaS Channel & Partnerships/);
  assert.match(draft.postText, /partners with defined launch plans/);
  assert.match(draft.postText, /building a channel/);
});

test('provider parser accepts exactly one draft for every verified URL', () => {
  const posts = articles.map((article, index) => ({
    title: `Draft ${index + 1}`,
    postText: `Post ${index + 1}`,
    url: article.url,
  }));

  assert.deepEqual(
    parseGeneratedDrafts(JSON.stringify({ posts }), articles.map(article => article.url)),
    posts,
  );
});

test('provider parser rejects invented and repeated URLs', () => {
  const posts = articles.map((article, index) => ({
    title: `Draft ${index + 1}`,
    postText: `Post ${index + 1}`,
    url: index === 2 ? articles[0].url : article.url,
  }));

  assert.throws(
    () => parseGeneratedDrafts(JSON.stringify({ posts }), articles.map(article => article.url)),
    /unverified or repeated article URL/,
  );
});

test('provider parser rejects incomplete batches', () => {
  const posts = articles.slice(0, 2).map((article, index) => ({
    title: `Draft ${index + 1}`,
    postText: `Post ${index + 1}`,
    url: article.url,
  }));

  assert.throws(
    () => parseGeneratedDrafts(JSON.stringify({ posts }), articles.map(article => article.url)),
    /one draft for every article/,
  );
});
