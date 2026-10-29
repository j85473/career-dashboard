import type { CrawlQueue } from './atsCrawlingSchedule';
export const CRAWL_TIME_SHARES: Record<CrawlQueue, number> = { first: 0.4, refresh: 0.3, continuation: 0.2, retry: 0.1 };
/** Lowest spent/share wins. Missing queues lend their allocation to available work. */
export function crawlTimeOrder(spent: Record<CrawlQueue, number>): CrawlQueue[] {
    return (Object.keys(CRAWL_TIME_SHARES) as CrawlQueue[]).sort((a,b) => spent[a]/CRAWL_TIME_SHARES[a]-spent[b]/CRAWL_TIME_SHARES[b]);
}
