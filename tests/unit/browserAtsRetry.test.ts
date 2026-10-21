import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCrawlRetry } from '../../src/lib/browserAtsRetry';
import { BrowserAtsHttpHandoff, BrowserSweepDeferred } from '../../src/lib/browserAtsTransport';
import { browserTurnYieldAt } from '../../src/lib/browserAtsWorker';

const now = new Date('2026-10-21T14:00:00Z'), HOUR = 3_600_000, DAY = 24 * HOUR;
test('unavailable boards retain retry eligibility with increasingly sparse checks instead of repeated daily attempts', () => {
    for (const message of ['Board returned HTTP 404', 'Board returned HTTP 410', 'page.goto: net::ERR_NAME_NOT_RESOLVED', 'getaddrinfo ENOTFOUND employer.example', 'Public employer tenant is unavailable; retain for weekly retry']) {
        for (const [failures, days] of [[0, 7], [1, 7], [3, 14], [5, 28], [99, 28]]) {
            const policy = browserCrawlRetry(message, failures, now);
            assert.equal(policy.kind, 'unavailable');
            assert.equal(policy.delayMs, days * DAY);
            assert.equal(policy.nextRetryAt.getTime(), now.getTime() + days * DAY);
        }
    }
});
test('missing evidence gets a bounded retry and cannot turn an incomplete traversal into a completed board', () => {
    for (const message of ['Only 243 of 245 advertised jobs enumerated; retaining progress', 'Public board did not expose verifiable posting links or an explicit empty state', 'Job detail lacks a verified employer, title, or full description: 42', 'Taleo turn exhausted its time budget without advancing saved progress; retaining cursor for retry']) {
        assert.equal(browserCrawlRetry(message, 0, now).delayMs, 6 * HOUR);
        assert.equal(browserCrawlRetry(message, 20, now).delayMs, 7 * DAY);
        assert.equal(browserCrawlRetry(message, 0, now).kind, 'incomplete');
    }
});
test('rate limits and transient failures keep shorter recovery opportunities with finite caps', () => {
    assert.equal(browserCrawlRetry('HTTP 429', 0, now).delayMs, 6 * HOUR);
    assert.equal(browserCrawlRetry('HTTP 403', 99, now).delayMs, 3 * DAY);
    for (const message of ['HTTP 500', 'HTTP 503', 'page.goto: Timeout 45000ms exceeded', 'TransactionWriteConflict']) {
        assert.equal(browserCrawlRetry(message, 0, now).delayMs, HOUR);
        assert.equal(browserCrawlRetry(message, 99, now).delayMs, DAY);
    }
    assert.equal(browserCrawlRetry('HTTP 500', NaN, now).delayMs, HOUR);
});
test('transport handoffs, operator holds, lease loss and shutdown remain deferrals without failure backoff', () => {
    for (const error of [new BrowserAtsHttpHandoff('detail'), new BrowserSweepDeferred('operator pause'), new BrowserSweepDeferred('lease lost'), new BrowserSweepDeferred('shutdown')]) {
        assert.ok(error instanceof BrowserSweepDeferred);
        assert.equal(browserTurnYieldAt(error, false, now), null);
    }
    assert.equal(browserTurnYieldAt(new BrowserSweepDeferred('budget', true), false, now)?.getTime(), now.getTime() + 1000);
});
