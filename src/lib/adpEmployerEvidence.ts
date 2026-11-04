import * as cheerio from 'cheerio';
import { adpPostingIdentity } from './adpPostingIdentity';
import { manualImportCompanyValue } from './manualImportPolicy';
import { employerWebsiteName, publishedEmployerName } from './publicAtsEmployer';
import { readBoundedAtsBody } from './tenantAtsBoards';

/** The public page uses ClientName, not ClientID, as the employer's name. */
export function adpClientFeaturesUrl(value: string): string | null {
  const identity = adpPostingIdentity(value);
  if (!identity) return null;
  const url = new URL('/mascsr/default/careercenter/public/events/staffing/client-features', identity.origin);
  for (const [key, value] of Object.entries({ cid: identity.cid, ccId: identity.ccId, lang: 'en_US', jobId: identity.jobId })) url.searchParams.set(key, value);
  return url.toString();
}

export function parseAdpClientCompany(body: unknown): string | undefined {
  const fields = (body as { meta?: { customFieldGroup?: { stringFields?: unknown } } } | null)?.meta?.customFieldGroup?.stringFields;
  if (!Array.isArray(fields)) return undefined;
  const names = new Set<string>();
  for (const field of fields) {
    if (!['ClientName', 'CLIENT_NAME'].includes(field?.nameCode?.codeValue)) continue;
    if (typeof field.stringValue === 'string' && !field.stringValue.trim()) continue;
    const name = typeof field.stringValue === 'string' ? manualImportCompanyValue(field.stringValue) : undefined;
    if (!name || name.length > 200 || /^(?:ADP|Workforce Now|ADP Workforce Now|Default(?: Brand(?:ing)?)?|Recruitment|Careers?)$/i.test(name)) return undefined;
    names.add(name);
  }
  return names.size === 1 ? [...names][0] : undefined;
}

export type AdpPublicFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type AdpCareerCenter = { contentLinks?: Array<{ linkTypeCode?: { codeValue?: string }; contentBody?: { links?: Array<{ href?: string }> } }>;
    meta?: { customFieldGroup?: { indicatorFields?: Array<{ nameCode?: { codeValue?: string }; indicatorValue?: boolean }> } } };
export class AdpPublicResponseError extends Error {}

/** Only the career center's explicit corporate link supplies a website lookup.
 * Social links, opaque tenant IDs and logo filenames never supply a name. */
export function adpEmployerWebsite(body: AdpCareerCenter): string | null {
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

export async function readAdpPublicJson(url: string, fetcher: AdpPublicFetcher,
    check: () => Promise<void> = async () => {}): Promise<unknown> {
        await check();
        try {
            const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
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


export function adpCareerCenterUrl(postingUrl: string): string | null {
    const identity = adpPostingIdentity(postingUrl);
    if (!identity) return null;
    const url = new URL('/mascsr/default/careercenter/public/events/staffing/v1/content-links/career-center', identity.origin);
    for (const [key, value] of Object.entries({ cid: identity.cid, ccId: identity.ccId, lang: 'en_US', locale: 'en_US' })) url.searchParams.set(key, value);
    return url.href;
}

/** One reader per board turn or import; only published same-board evidence is
 * cached. An unavailable optional source never discards the verified posting. */
export class AdpEmployerEvidence {
    private employer?: Promise<{ name?: string; title?: string }>;
    constructor(private dependencies: {
        json: (url: string) => Promise<unknown>;
        careerCenter: () => Promise<AdpCareerCenter>;
        check: () => Promise<void>;
        fetcher: AdpPublicFetcher;
    }) {}
    async company(postingUrl: string, postingText: string): Promise<string | undefined> {
        const identity: { name?: string; title?: string } = await (this.employer ||= (async () => {
            let configured: string | undefined;
            try { configured = parseAdpClientCompany(await this.dependencies.json(adpClientFeaturesUrl(postingUrl)!)); }
            catch (error) { if (!(error instanceof AdpPublicResponseError)) throw error; }
            if (configured) return { name: configured };
            const site = adpEmployerWebsite(await this.dependencies.careerCenter());
            if (!site) return {};
            await this.dependencies.check();
            let response: Response;
            try { response = await this.dependencies.fetcher(site, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }); }
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

}
