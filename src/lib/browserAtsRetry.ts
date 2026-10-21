const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type BrowserCrawlFailure = 'unavailable' | 'access' | 'incomplete' | 'transient';

/** Prospective board retries only. Never converts missing evidence into an empty/successful crawl. */
export function browserCrawlRetry(error: string, previousFailures: number, now = new Date()) {
    const failures = Math.max(0, Math.floor(Number.isFinite(previousFailures) ? previousFailures : 0));
    let kind: BrowserCrawlFailure = 'transient';
    let delayMs: number;
    if (/\bHTTP (?:404|410)\b|ERR_NAME_NOT_RESOLVED|\bENOTFOUND\b|retain for weekly retry/i.test(error)) {
        kind = 'unavailable';
        delayMs = (failures >= 5 ? 28 : failures >= 3 ? 14 : 7) * DAY;
    } else if (/\bHTTP (?:401|403|429)\b|access denied|verify you are human|captcha|cloudflare challenge/i.test(error)) {
        kind = 'access';
        delayMs = Math.min(3 * DAY, 6 * HOUR * 2 ** Math.min(failures, 4));
    } else if (/did not expose verifiable|lacks a verified|cannot validate|advertised jobs enumerated|retaining progress for review|saved.*(?:match|progress)|Pagination repeated|pagination.*(?:missing|timeout)|full-board search control is missing|Taleo turn exhausted/i.test(error)) {
        kind = 'incomplete';
        delayMs = Math.min(7 * DAY, 6 * HOUR * 2 ** Math.min(failures, 5));
    } else {
        delayMs = Math.min(DAY, HOUR * 2 ** Math.min(failures, 5));
    }
    return { kind, delayMs, nextRetryAt: new Date(now.getTime() + delayMs) };
}
