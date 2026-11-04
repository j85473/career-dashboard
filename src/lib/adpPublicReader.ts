import { AdpEmployerEvidence, AdpPublicResponseError, readAdpPublicJson, type AdpCareerCenter, type AdpPublicFetcher } from './adpEmployerEvidence';
export { adpEmployerWebsite } from './adpEmployerEvidence';
import { createHash } from 'node:crypto';
import { browserAtsBoardFromUrl } from './browserAtsBoards';
import { browserPostingLink, type BrowserPosting, type BrowserPostingLink } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';
import { parseAdpPosting } from './adpPosting';
import { safeExternalFetch } from './safeExternalFetch';
import { isPlaceholderEmployerName } from './companyIdentity';

/** One reader per board turn coalesces configuration and corporate-name reads. */
export class AdpPublicReader {
    private center?: Promise<AdpCareerCenter>;
    private employer: AdpEmployerEvidence;
    constructor(private board: string, private check: () => Promise<void> = async () => {}, private fetcher: AdpPublicFetcher = safeExternalFetch) {
        if (browserAtsBoardFromUrl('adp', board) !== board) throw Error('Invalid ADP public-board identity');
        this.employer = new AdpEmployerEvidence({ json: url => this.json(url), careerCenter: () => this.careerCenter(), check, fetcher });
    }

    private endpoint(path: string): URL {
        const board = new URL(this.board);
        const url = new URL('/mascsr/default/careercenter/public/events/staffing/' + path, board);
        for (const key of ['cid', 'ccId', 'lang']) url.searchParams.set(key, board.searchParams.get(key)!);
        url.searchParams.set('locale', 'en_US');
        return url;
    }

    private json(url: string): Promise<unknown> {
        return readAdpPublicJson(url, this.fetcher, this.check);
    }

    private careerCenter(): Promise<AdpCareerCenter> {
        return this.center ||= this.json(this.endpoint('v1/content-links/career-center').href).then(body => {
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AdpPublicResponseError('ADP career-center schema changed');
            return body as AdpCareerCenter;
        });
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
        const name = !isPlaceholderEmployerName(posting.company) ? posting.company : await this.employer.company(link.url, posting.text);
        const company = name && !isPlaceholderEmployerName(name) ? name : 'Unknown Company';
        return { ...link, title: posting.title, company, description: posting.text, location: posting.location || '' };
    }
}
