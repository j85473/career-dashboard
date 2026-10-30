import * as cheerio from 'cheerio';
import type { BrowserDocument } from './browserAtsPosting';

/** A vendor's explicit unavailable page is a retry, never an empty catalogue. */
export function assertPublicBoardAvailable(platform: string, doc: BrowserDocument): void {
    if (platform !== 'paylocity') return;
    const url = new URL(doc.url), $ = cheerio.load(doc.html);
    if (url.protocol === 'https:' && url.hostname === 'recruiting.paylocity.com'
        && /^\/recruiting\/jobs\/JobNotFound\/?$/i.test(url.pathname)
        && $('title').text().trim() === 'Job Not Found'
        && /We're sorry, that job does not exist or is not currently active\./.test(doc.text)
        && (/Powered by Paylocity/.test(doc.text)
            || $('aside[aria-label="Powered by Paylocity Logo and Link"] img').attr('src') === 'https://cdn.paylocity.com/cdn/branding/paylocity-logo-left.svg'))
        throw Error('Paylocity reports this public board is unavailable; retain for weekly retry');
}
