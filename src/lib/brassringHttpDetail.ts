import * as cheerio from 'cheerio';
import { browserAtsBoardFromUrl } from './browserAtsBoards';
import { browserPostingLink, cleanBrowserHtml, type BrowserPosting, type BrowserPostingLink } from './browserAtsPosting';
import { isPlaceholderEmployerName } from './companyIdentity';
import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';

type Fetcher = (url: string, init: RequestInit, maxRedirects?: number) => Promise<Response>;
type Session = { company: string; cookies: Map<string, string> };
type Question = { QuestionName: string; AnswerValue: string; VerityZone: string; ClassName: string | null };
const companyKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();
const usableCompany = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 1 && value.length < 200
    && !isPlaceholderEmployerName(value) && /[a-z]/i.test(value) && !/^(?:BrassRing|careers?|jobs?)$/i.test(value.trim());
const text = (value: string) => cleanBrowserHtml(value).replace(/\s+/g, ' ').trim();

/** Only the publisher's exact job response can become a posting. Preserve every
 * displayed field, including requirements/pay/benefits outside the main JD. */
export function parseBrassringHttpDetail(board: string, link: BrowserPostingLink, company: string, input: unknown): BrowserPosting | null {
    if (browserAtsBoardFromUrl('brassring', board) !== board || browserPostingLink('brassring', board, link.url)?.id !== link.id || !usableCompany(company)) return null;
    const root = input as { ServiceResponse?: { SolarErrorOccurred?: unknown; partnername?: unknown; Jobdetails?: {
        isActive?: unknown; Title?: unknown; Link?: unknown; JobSiteId?: unknown; JobDetailQuestions?: unknown;
    }; JobFieldsToDisplay?: { Summary?: unknown } } } | null;
    const response = root?.ServiceResponse, job = response?.Jobdetails, site = new URL(board).searchParams.get('siteid');
    if (!response || response.SolarErrorOccurred !== false || !usableCompany(response.partnername) || companyKey(response.partnername) !== companyKey(company)
        || !job || job.isActive !== true || typeof job.Link !== 'string' || browserPostingLink('brassring', board, job.Link)?.id !== link.id
        || job.JobSiteId != null && String(job.JobSiteId) !== site || typeof job.Title !== 'string' || !job.Title.trim()
        || !Array.isArray(job.JobDetailQuestions) || job.JobDetailQuestions.length > 100) return null;
    const questions = job.JobDetailQuestions as Question[];
    if (questions.some(q => !q || typeof q.QuestionName !== 'string' || typeof q.AnswerValue !== 'string' || typeof q.VerityZone !== 'string'
        || q.ClassName !== null && typeof q.ClassName !== 'string')) return null;
    const exact = (zone: string, expected: string) => {
        const values = questions.filter(q => q.VerityZone.toLowerCase() === zone);
        return values.length === 1 && text(values[0].AnswerValue) === expected;
    };
    const title = text(job.Title);
    if (!exact('reqid', link.id) || !exact('siteid', site!) || !exact('jobtitle', title)) return null;
    const summary = response.JobFieldsToDisplay?.Summary;
    if (typeof summary !== 'string' || !summary) return null;
    const main = questions.filter(q => q.VerityZone === summary && q.ClassName === 'jobdescriptionInJobDetails');
    if (main.length !== 1 || cleanBrowserHtml(main[0].AnswerValue).length < 200) return null;
    const fields = questions.filter(q => !!q.ClassName && text(q.AnswerValue)).map(q => {
        const label = text(q.QuestionName), value = cleanBrowserHtml(q.AnswerValue);
        return label ? label + '\n' + value : value;
    });
    const description = [title, ...fields].join('\n\n');
    const places = questions.filter(q => q.VerityZone.toLowerCase() === 'location'
        || /^(?:city|state(?:\s*\/\s*(?:region|province))*|country|work locations?|job locations?|locations?|store address|address(?: line \d+)?|zip(?: code)?|postal code)$/i.test(text(q.QuestionName)))
        .map(q => text(q.AnswerValue)).filter(Boolean);
    return { ...link, title, company: company.trim(), description, location: [...new Set(places)].join('; ') };
}

/** Anonymous sessions last only for this bounded board turn. They are never
 * shared with the licensed browser, persisted, or forwarded to another host. */
export class BrassringHttpDetailReader {
    private sessions = new Map<string, Session>();
    constructor(private check: () => Promise<void> = async () => {}, private fetcher: Fetcher = safeExternalFetch) {}
    private updateCookies(cookies: Map<string, string>, headers: Headers) {
        for (const value of headers.getSetCookie()) {
            const pair = /^([A-Za-z0-9_]+)=([^;\r\n]*)/.exec(value);
            if (pair && pair[2].length <= 4096 && (cookies.has(pair[1]) || cookies.size < 32)) cookies.set(pair[1], pair[2]);
        }
    }
    private async request(url: string, init: RequestInit): Promise<{ response: Response; body: string } | null> {
        await this.check();
        try {
            // A redirected POST is not evidence about the requested employer or
            // job. Refuse redirects rather than forwarding session cookies.
            const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(10000) }, 0);
            if (!response.ok || response.url && response.url !== url) { await response.body?.cancel(); return null; }
            return { response, body: await readBoundedAtsBody(response, 5 * 1024 * 1024) };
        } catch { return null; }
    }
    private async session(board: string, link: BrowserPostingLink): Promise<Session | null> {
        const cached = this.sessions.get(board);
        if (cached) return cached;
        // The generic home shell can leave its public configuration empty.
        // The published exact-job permalink includes the employer configuration
        // even when that job has closed; it also establishes the public cookies.
        const target = new URL('/TGnewUI/Search/home/HomeWithPreLoad', board), params = new URL(board).searchParams;
        for (const key of ['partnerid', 'siteid']) target.searchParams.set(key, params.get(key)!);
        target.searchParams.set('PageType', 'JobDetails');
        target.searchParams.set('jobid', link.id);
        const result = await this.request(target.href, { headers: { Accept: 'text/html' } });
        if (!result) return null;
        try {
            const $ = cheerio.load(result.body);
            if ($('#partnerId').length !== 1 || $('#siteId').length !== 1 || $('#preLoadJSON').length !== 1
                || $('#partnerId').attr('value') !== params.get('partnerid') || $('#siteId').attr('value') !== params.get('siteid')) return null;
            const model = JSON.parse($('#preLoadJSON').attr('value') || '') as { ClientSettings?: { PartnerName?: unknown } };
            if (!usableCompany(model.ClientSettings?.PartnerName)) return null;
            const session: Session = { company: model.ClientSettings.PartnerName.trim(), cookies: new Map() };
            this.updateCookies(session.cookies, result.response.headers);
            if (!session.cookies.size) return null;
            if (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value!);
            this.sessions.set(board, session);
            return session;
        } catch { return null; }
    }
    async detail(board: string, link: BrowserPostingLink): Promise<BrowserPosting | null> {
        await this.check();
        if (browserAtsBoardFromUrl('brassring', board) !== board || browserPostingLink('brassring', board, link.url)?.id !== link.id) return null;
        const session = await this.session(board, link);
        if (!session) return null;
        const b = new URL(board), endpoint = new URL('/TgNewUI/Search/Ajax/JobDetails', b).href;
        const result = await this.request(endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest', Referer: board, Origin: b.origin,
            Cookie: [...session.cookies].map(([key, value]) => key + '=' + value).join('; ') },
            body: JSON.stringify({ partnerId: b.searchParams.get('partnerid'), siteId: b.searchParams.get('siteid'), jobid: link.id,
                configMode: '', jobSiteId: b.searchParams.get('siteid'), turnOffHttps: false }) });
        if (!result) { this.sessions.delete(board); return null; }
        await this.check();
        this.updateCookies(session.cookies, result.response.headers);
        try { return parseBrassringHttpDetail(board, link, session.company, JSON.parse(result.body)); }
        catch { return null; }
    }
}
