import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplyRedirectResolver,
  DEFAULT_SCRAPER_BUDGET_MS,
  emptyScraperCounts,
  ingestionSummaryLine,
  scraperBudgetFromEnvironment,
} from '../scraperRuntime';
import { SCRAPER_GRACEFUL_BUDGET_MS, SCRAPER_HARD_KILL_MS } from '../jobIngestion';

function fakeClock(start = 0) {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

test('the budget expires only once its window has fully elapsed', () => {
  const clock = fakeClock();
  const budget = scraperBudgetFromEnvironment({ SCRAPER_BUDGET_MS: '1000' }, clock.now);
  assert.equal(budget.expired(), false);
  clock.advance(999);
  assert.equal(budget.expired(), false);
  assert.equal(budget.remainingMs(), 1);
  clock.advance(1);
  assert.equal(budget.expired(), true);
  assert.equal(budget.remainingMs(), 0);
});

test('a missing or nonsensical budget falls back to the default', () => {
  const clock = fakeClock();
  for (const environment of [{}, { SCRAPER_BUDGET_MS: 'abc' }, { SCRAPER_BUDGET_MS: '0' }, { SCRAPER_BUDGET_MS: '-5' }]) {
    const budget = scraperBudgetFromEnvironment(environment, clock.now);
    assert.equal(budget.expired(), false);
    assert.equal(budget.remainingMs(), DEFAULT_SCRAPER_BUDGET_MS);
  }
});

test('the hard kill always sits above the graceful budget', () => {
  // If the backstop could land first, the kill would arrive mid-work and book a
  // hard failure — which is how Dejobs stayed circuit-open for three days.
  assert.ok(SCRAPER_HARD_KILL_MS > SCRAPER_GRACEFUL_BUDGET_MS);
  assert.ok(SCRAPER_HARD_KILL_MS - SCRAPER_GRACEFUL_BUDGET_MS >= 5 * 60 * 1000);
});

test('the summary line reports whether the run finished or ran out of time', () => {
  const counts = { ...emptyScraperCounts(), seen: 50, inserted: 2, duplicates: 47, filtered: 1 };
  const finished = JSON.parse(ingestionSummaryLine(counts, false).replace('INGESTION_SUMMARY ', ''));
  assert.equal(finished.budgetExhausted, false);
  assert.equal(finished.inserted, 2);
  // Counters still reconcile: seen === inserted + duplicates + filtered + errors.
  assert.equal(
    finished.seen,
    finished.inserted + finished.duplicates + finished.filtered + finished.processingErrors,
  );
  const truncated = JSON.parse(ingestionSummaryLine(counts, true).replace('INGESTION_SUMMARY ', ''));
  assert.equal(truncated.budgetExhausted, true);
});

test('the parent still parses the summary line it has always parsed', () => {
  const line = ingestionSummaryLine(emptyScraperCounts(), false);
  assert.match(line, /^INGESTION_SUMMARY\s+(\{.*\})$/);
});

function fakeBrowser(pages: unknown[]) {
  let created = 0;
  return {
    createdCount: () => created,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newPage: async () => { created++; return pages[created - 1] as any; },
  };
}

function fakePage(applyHref: string | null, finalUrl: string) {
  return {
    gotos: [] as string[],
    closed: false,
    async goto(url: string) { this.gotos.push(url); },
    async evaluate() { return applyHref; },
    url: () => finalUrl,
    async close() { this.closed = true; },
  };
}

test('the resolver reuses one page across listings instead of opening one each', async () => {
  const page = fakePage('https://jobsyn.org/abc', 'https://employer.example/job/1');
  const browser = fakeBrowser([page]);
  const resolver = new ApplyRedirectResolver(browser, () => {}, 0);

  assert.equal(await resolver.resolve('https://de.jobsyn.org/one'), 'https://employer.example/job/1');
  assert.equal(await resolver.resolve('https://de.jobsyn.org/two'), 'https://employer.example/job/1');
  // Previously this opened and closed a browser page per card.
  assert.equal(browser.createdCount(), 1);
  await resolver.dispose();
  assert.equal(page.closed, true);
});

test('a listing with no apply button resolves to itself rather than failing', async () => {
  const page = fakePage(null, 'https://unused.example');
  const resolver = new ApplyRedirectResolver(fakeBrowser([page]), () => {}, 0);
  assert.equal(await resolver.resolve('https://de.jobsyn.org/none'), 'https://de.jobsyn.org/none');
  await resolver.dispose();
});

test('a navigation failure drops the page so the next listing gets a fresh one', async () => {
  const broken = {
    async goto() { throw new Error('navigation timeout'); },
    async evaluate() { return null; },
    url: () => '',
    closed: false,
    async close() { this.closed = true; },
  };
  const healthy = fakePage('https://jobsyn.org/ok', 'https://employer.example/job/2');
  const browser = fakeBrowser([broken, healthy]);
  const resolver = new ApplyRedirectResolver(browser, () => {}, 0);

  // The failure returns the original URL rather than throwing out of the run.
  assert.equal(await resolver.resolve('https://de.jobsyn.org/broken'), 'https://de.jobsyn.org/broken');
  assert.equal(broken.closed, true);
  assert.equal(await resolver.resolve('https://de.jobsyn.org/ok'), 'https://employer.example/job/2');
  assert.equal(browser.createdCount(), 2);
  await resolver.dispose();
});
