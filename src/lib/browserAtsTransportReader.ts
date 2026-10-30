import type { BrowserAtsPlatform } from './browserAtsBoards';
import { canUseBrowserAtsHttp, canUseBrowserAtsHttpDetail, type BrowserAtsHttpReader } from './browserAtsHttp';
import type { BrowserAtsReader, BrowserListing } from './browserAtsReader';
import type { BrowserPosting, BrowserPostingLink } from './browserAtsPosting';
import type { BrowserSweepProgress } from './browserAtsProgress';
import { BrowserAtsHttpHandoff } from './browserAtsTransport';

export type PublicCrawlTransportCost = {
    httpListings: number; httpDetails: number; browserListings: number; browserDetails: number;
};

/** Reader selection has no persistence side effects. A handoff throws before the current posting advances. */
export class PublicCrawlReader {
    private httpDetailsAvailable: boolean;
    constructor(private input: {
        platform: BrowserAtsPlatform;
        board: string;
        progress: () => BrowserSweepProgress;
        browserAllowed: boolean;
        http: Pick<BrowserAtsHttpReader, 'page' | 'detail'>;
        browser: () => Promise<Pick<BrowserAtsReader, 'page' | 'detail'>>;
        cost: PublicCrawlTransportCost;
        adp: { listing: (board: string, page: number) => Promise<BrowserListing>; detail: (board: string, link: BrowserPostingLink) => Promise<BrowserPosting | null> };
    }) {
        this.httpDetailsAvailable = input.progress().browserRequired !== 'detail';
    }
    private handoff(required: 'listing' | 'detail'): never {
        this.input.progress().browserRequired = required;
        throw new BrowserAtsHttpHandoff(required);
    }

    async listing(): Promise<BrowserListing> {
        const { platform, board, cost } = this.input, progress = this.input.progress();
        if (platform === 'adp') { cost.httpListings++; return this.input.adp.listing(board, progress.page); }
        if (!progress.transport && (progress.page > 1 || progress.loaded || progress.seen.length > 0)) progress.transport = 'browser-v1';
        // No acquired page or posting exists yet, so updated HTTP readers can
        // safely retry an old initial handoff without reinterpreting any cursor.
        const untouched = progress.page === 1 && !progress.loaded && !progress.queue.length && !progress.seen.length
            && !progress.signatures.length && !progress.pageUrl && !progress.next && !progress.offset && !progress.detailFailures?.length;
        if (canUseBrowserAtsHttp(platform) && (untouched || progress.transport !== 'browser-v1' && progress.browserRequired !== 'listing')) {
            const listing = await this.input.http.page(platform, board, progress.page, progress.pageUrl);
            if (listing) {
                cost.httpListings++; progress.transport = 'http-v1';
                delete progress.browserRequired; this.httpDetailsAvailable = true;
                return listing;
            }
            // HTTP pagination cannot become browser pagination midway through a sweep.
            if (progress.transport === 'http-v1') throw Error('Public HTTP listing unavailable; preserving its exact traversal for retry');
            this.httpDetailsAvailable = false;
        }
        if (!this.input.browserAllowed) return this.handoff('listing');
        progress.transport = 'browser-v1';
        cost.browserListings++;
        return (await this.input.browser()).page(platform, board, progress.page, progress.pageUrl);
    }

    async detail(link: BrowserPostingLink): Promise<BrowserPosting | null> {
        const { platform, board, cost } = this.input;
        if (platform === 'adp') { cost.httpDetails++; return this.input.adp.detail(board, link); }
        if (canUseBrowserAtsHttpDetail(platform) && this.httpDetailsAvailable) {
            const progress = this.input.progress();
            const savedCatalogue = platform === 'paycom' && progress.transport === 'http-v1' && progress.loaded
                && progress.page === 1 && !progress.next && progress.total === progress.queue.length ? progress.queue : undefined;
            const detail = await this.input.http.detail(platform, board, link, savedCatalogue);
            if (detail) { cost.httpDetails++; return detail; }
            this.httpDetailsAvailable = false;
        }
        if (!this.input.browserAllowed) return this.handoff('detail');
        cost.browserDetails++;
        return (await this.input.browser()).detail(platform, board, link);
    }
}
