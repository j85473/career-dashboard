import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { browserAtsBoardFromUrl } from './browserAtsBoards';
import { browserPostingLink, type BrowserPosting, type BrowserPostingLink } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';
import { adpClientFeaturesUrl, parseAdpClientCompany, parseAdpPosting } from './adpPosting';
import { employerWebsiteName, publishedEmployerName } from './publicAtsEmployer';
import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { isPlaceholderEmployerName } from './companyIdentity';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type CareerCenter = { contentLinks?: Array<{ linkTypeCode?: { codeValue?: string }; contentBody?: { links?: Array<{ href?: string }> } }>;
    meta?: { customFieldGroup?: { indicatorFields?: Array<{ nameCode?: { codeValue?: string }; indicatorValue?: boolean }> } } };
class AdpPublicResponseError extends Error {}

/** Only the career center's explicit corporate link supplies a website lookup.
 * Social links, opaque tenant IDs and logo filenames never supply a name. */
export function adpEmployerWebsite(body: CareerCenter): string | null {
    const links = (body.contentLinks || []).filter(link => ['LINKS-BRND', 'IMG_LOGO'].includes(link.linkTypeCode?.codeValue || ''))
        .flatMap(link => link.contentBody?.links || []).flatMap(link => {
            try {
                const published = decodeURIComponent(link.href || '').trim();
                // Some centers publish an explicit corporate hostname without
                // a scheme. Preserve that host; no tenant/name guessing.
                const hostOnly = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[/?#]|$)/i.test(published);
                const url = new URL(hostOnly ? 'https://' + published : published);
                if (url.protocol !== 'https:' || url.username || url.password || url.port
                    || /(?:^|\.)(?:adp\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|twitter\.com|x\.com)$/.test(url.hostname)) return [];
                return [url.href];
            } catch { return []; }
        });
    const unique = [...new Set(links)];
    if (unique.length === 1) return unique[0];
    // Career centers can list Website, Culture and Careers for one employer.
    // Prefer its explicitly published home URL, never guess one from a path.
    const hosts = new Set(unique.map(link => new URL(link).hostname.replace(/^www\./, '')));
    return hosts.size === 1 ? unique.find(link => {
        const url = new URL(link);
        return url.pathname === '/' && !url.search && !url.hash;
    }) || null : null;
}

/** One reader per board turn coalesces configuration and corporate-name reads. */
export class AdpPublicReader {
    private center?: Promise<CareerCenter>;
    private employer?: Promise<{ name?: string; title?: string }>;
    constructor(private board: string, private check: () => Promise<void> = async () => {}, private fetcher: Fetcher = safeExternalFetch) {
        if (browserAtsBoardFromUrl('adp', board) !== board) throw Error('Invalid ADP public-board identity');
    }

    private endpoint(path: string): URL {
        const board = new URL(this.board);
        const url = new URL('/mascsr/default/careercenter/public/events/staffing/' + path, board);
        for (const key of ['cid', 'ccId', 'lang']) url.searchParams.set(key, board.searchParams.get(key)!);
        url.searchParams.set('locale', 'en_US');
        return url;
    }

    private async json(url: string): Promise<unknown> {
        await this.check();
        try {
            const response = await this.fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
            if (!response.ok) {
                await response.body?.cancel();
                throw Error('Public JSON HTTP ' + response.status);
            }
            if (response.url && response.url !== url) {
                await response.body?.cancel();
                throw Error('ADP public JSON redirected away from its requested identity');
            }
            return JSON.parse(await readBoundedAtsBody(response, 5 * 1024 * 1024));
        } catch (error) {
            // Operator/admission checks above must propagate unchanged. Only
            // optional HTTP/response failures can fall through to other proof.
            throw new AdpPublicResponseError(error instanceof Error ? error.message : String(error), { cause: error });
        }
    }

    private careerCenter(): Promise<CareerCenter> {
        return this.center ||= this.json(this.endpoint('v1/content-links/career-center').href).then(body => {
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AdpPublicResponseError('ADP career-center schema changed');
            return body as CareerCenter;
        });
    }

    private async company(postingUrl: string, postingText: string): Promise<string | undefined> {
        const identity: { name?: string; title?: string } = await (this.employer ||= (async () => {
            let configured: string | undefined;
            try { configured = parseAdpClientCompany(await this.json(adpClientFeaturesUrl(postingUrl)!)); }
            catch (error) { if (!(error instanceof AdpPublicResponseError)) throw error; }
            if (configured) return { name: configured };
            const site = adpEmployerWebsite(await this.careerCenter());
            if (!site) return {};
            await this.check();
            let response: Response;
            try { response = await this.fetcher(site, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }); }
            catch (error) { throw new AdpPublicResponseError('ADP employer website is unavailable', { cause: error }); }
            if (!response.ok) { await response.body?.cancel(); return {}; }
            const landed = new URL(response.url || site), requested = new URL(site);
            if (landed.protocol !== 'https:' || landed.hostname.replace(/^www\./, '') !== requested.hostname.replace(/^www\./, '')) {
                await response.body?.cancel(); return {};
            }
            let html: string;
            try { html = await readBoundedAtsBody(response, 5 * 1024 * 1024); }
            catch (error) { throw new AdpPublicResponseError('ADP employer website could not be read', { cause: error }); }
            const name = employerWebsiteName(html, site, landed.href);
            if (name && name.length <= 200) return { name };
            // Some corporate homepages publish only a plain company title.
            // It is a candidate until the exact posting independently names it.
            const title = publishedEmployerName(cheerio.load(html)('title').text());
            return title.length >= 5 && title.length <= 120 && !/[|<>:]/.test(title) ? { title } : {};
        })().catch(error => {
            if (error instanceof AdpPublicResponseError) return {};
            throw error;
        }));
        if (identity.name) return identity.name;
        if (identity.title) {
            const escaped = identity.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}\\s+(?:is|are)\\s+(?:seeking|hiring|recruiting|looking\\s+for)\\b`, 'iu').test(postingText)) return identity.title;
        }
        return undefined;
    }

    async listing(page: number): Promise<BrowserListing> {
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw Error('Invalid ADP listing page');
        const url = this.endpoint('v1/job-requisitions');
        url.searchParams.set('$top', '20');
        // ADP's public offsets are one-based; the omitted first offset starts at 1.
        if (page > 1) url.searchParams.set('$skip', String((page - 1) * 20 + 1));
        const data = await this.json(url.href) as { jobRequisitions?: unknown[]; meta?: { totalNumber?: unknown } } | null;
        if (Array.isArray(data?.jobRequisitions) && !data.jobRequisitions.length && data.meta?.totalNumber === undefined)
            throw Error('Public employer catalogue has no verifiable jobs; retain for weekly retry');
        if (!Array.isArray(data?.jobRequisitions) || typeof data.meta?.totalNumber !== 'number'
            || !Number.isSafeInteger(data.meta.totalNumber) || data.meta.totalNumber < 0 || data.jobRequisitions.length > 20)
            throw Error('ADP listing schema changed');
        const links = data.jobRequisitions.map(raw => {
            const job = raw as { requisitionTitle?: unknown; customFieldGroup?: { stringFields?: Array<{ nameCode?: { codeValue?: unknown }; stringValue?: unknown }> } } | null;
            const id = job?.customFieldGroup?.stringFields?.find(field => field.nameCode?.codeValue === 'ExternalJobID')?.stringValue;
            if (typeof id !== 'string' || !/^\d+$/.test(id) || typeof job?.requisitionTitle !== 'string' || !job.requisitionTitle.trim())
                throw Error('ADP listing has no stable published job identity');
            const target = new URL(this.board); target.searchParams.set('jobId', id);
            const link = browserPostingLink('adp', this.board, target.href, job.requisitionTitle);
            if (!link) throw Error('ADP listing has no stable published job ID');
            return { ...link, titleVerified: true };
        });
        if (new Set(links.map(link => link.id)).size !== links.length || links.length > data.meta.totalNumber)
            throw Error('ADP listing has inconsistent published job identities');
        let emptyVerified = false;
        if (!links.length && data.meta.totalNumber === 0 && page === 1) {
            const center = await this.careerCenter();
            const published = center.meta?.customFieldGroup?.indicatorFields?.filter(field => field.nameCode?.codeValue === 'PublishedIndicator');
            emptyVerified = published?.length === 1 && published[0].indicatorValue === true;
            if (!emptyVerified) throw Error('ADP empty catalogue lacks a verified published career center');
        }
        return { links, signature: createHash('sha256').update(links.map(link => link.id).sort().join('\n')).digest('hex'),
            total: data.meta.totalNumber, next: page * 20 < data.meta.totalNumber ? { kind: 'click' } : null, emptyVerified };
    }

    async detail(link: BrowserPostingLink): Promise<BrowserPosting> {
        if (browserPostingLink('adp', this.board, link.url)?.id !== link.id) throw Error('ADP posting escaped its career-center identity');
        const posting = parseAdpPosting(await this.json(this.endpoint('v1/job-requisitions/' + link.id).href), link.url);
        if (!posting) throw Error('ADP exact posting validation failed');
        // Employer branding enriches an already verified exact requisition;
        // an absent name must not stop this board's remaining postings.
        const name = !isPlaceholderEmployerName(posting.company) ? posting.company : await this.company(link.url, posting.text);
        const company = name && !isPlaceholderEmployerName(name) ? name : 'Unknown Company';
        return { ...link, title: posting.title, company, description: posting.text, location: posting.location || '' };
    }
}
