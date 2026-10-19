import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { extractJsonLdJobPosting, jsonLdCompanyName } from './atsApi';
export type BrowserPostingLink = {
    id: string;
    url: string;
    title: string;
    /** A provider's complete title field, rather than an arbitrary link/card label. */
    titleVerified?: boolean;
};
export type BrowserPosting = BrowserPostingLink & {
    company: string;
    description: string;
    location: string;
    postedAt?: Date;
};
export type BrowserDocument = {
    url: string;
    html: string;
    text: string;
};
export function browserPostingLink(platform: BrowserAtsPlatform, board: string, value: string, title = ''): BrowserPostingLink | null {
    try {
        const u = new URL(value, board), b = new URL(board);
        if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname !== b.hostname)
            return null;
        const p = u.pathname;
        let id: string | undefined;
        if (platform === 'adp' && browserAtsBoardFromUrl(platform, u.href) === board)
            id = u.searchParams.getAll('jobId').at(-1) || undefined;
        if (platform === 'icims')
            id = /^\/jobs\/(\d+)\/(?:[^/]+\/)?job\/?$/i.exec(p)?.[1];
        if (platform === 'avature' && browserAtsBoardFromUrl(platform, u.href) === board)
            id = /\/(?:JobDetail|FolderDetail)\/(?:[^/]+\/)*(\d+)\/?$/i.exec(p)?.[1];
        if (platform === 'paycom' && browserAtsBoardFromUrl(platform, u.href) === board)
            id = /\/jobs\/(\d+)\/?$/.exec(p)?.[1];
        if (platform === 'paylocity')
            id = /\/jobs\/Details\/(\d+)(?:\/|$)/i.exec(p)?.[1];
        if (platform === 'taleo' && browserAtsBoardFromUrl(platform, u.href) === board && /jobdetail\.ftl$/i.test(p))
            id = u.searchParams.get('job') || undefined;
        if (platform === 'brassring') {
            const params = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
            if (params.partnerid === b.searchParams.get('partnerid') && params.siteid === b.searchParams.get('siteid'))
                id = params.jobid || /^#jobDetails=(\d+)_/.exec(u.hash)?.[1];
            if (id) {
                const target = new URL(board);
                target.hash = `jobDetails=${id}_${b.searchParams.get('siteid')}`;
                u.href = target.href;
            }
        }
        if (platform === 'dzconnex')
            id = /\/job-details\/[^/]+-jobs-(\d+)\/?$/.exec(p)?.[1];
        if (platform === 'talemetry')
            id = /^\/jobs\/(\d+)-/.exec(p)?.[1];
        if (platform === 'sagehr')
            id = /^\/jobs\/([a-f0-9-]{36})\/?$/i.exec(p)?.[1];
        if (platform === 'phenom' && p.startsWith(b.pathname.replace(/search-results$/, '')))
            id = /\/job\/([^/]+)/.exec(p)?.[1];
        if (platform === 'jobvite' && p.startsWith(b.pathname.replace(/jobs$/, '')))
            id = /\/job\/([\w-]+)\/?$/.exec(p)?.[1];
        if (platform === 'freshteam')
            id = /^\/jobs\/([\w-]+)(?:\/[^/]+)?\/?$/.exec(p)?.[1];
        if (platform === 'cats' && p.startsWith(b.pathname))
            id = /\/jobs\/(\d+)(?:-|\/|$)/.exec(p)?.[1];
        if (!id || !/^[\w.-]+$/.test(id))
            return null;
        if (!['brassring', 'adp', 'taleo'].includes(platform)) {
            u.search = '';
            u.hash = '';
        }
        if (platform === 'taleo') {
            u.search = '';
            u.searchParams.set('job', id);
            u.hash = '';
        }
        return { id, url: u.href, title: title.replace(/^Title\s+/i, '').replace(/\s+/g, ' ').trim() };
    }
    catch {
        return null;
    }
}
export function browserPostingSourceId(board: string, id: string): string { return createHash('sha256').update(board).digest('hex').slice(0, 24) + ':' + id; }
export function cleanBrowserHtml(html: string): string {
    const $ = cheerio.load(html);
    $('script,style,noscript,form,nav,footer').remove();
    $('br,p,div,section,li,h1,h2,h3,h4').append('\n');
    return $.root().text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
/** Keep every published place and explicit applicant restriction, including country-only places. */
export function structuredBrowserLocation(posting: unknown): string {
    type Place = {
        address?: {
            addressLocality?: unknown;
            addressRegion?: unknown;
            addressCountry?: unknown;
        };
    };
    type Requirement = string | {
        name?: unknown;
    };
    const p = posting as {
        jobLocation?: Place | Place[];
        applicantLocationRequirements?: Requirement | Requirement[];
    } | null;
    if (!p)
        return '';
    const array = <T>(value: T | T[] | undefined): T[] => Array.isArray(value) ? value : value ? [value] : [];
    const places = array(p.jobLocation).map(place => {
        const a = place?.address;
        if (!a)
            return '';
        const country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry && typeof a.addressCountry === 'object' ? (a.addressCountry as {
            name?: unknown;
        }).name : undefined;
        return [...new Set([a.addressLocality, a.addressRegion, country].filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()))].join(', ');
    });
    const restrictions = array(p.applicantLocationRequirements).map(r => typeof r === 'string' ? r : r?.name).filter((x): x is string => typeof x === 'string');
    return [...new Set([...places, ...restrictions])].filter(Boolean).join('; ');
}
/** Parse a public JSON object without evaluating the surrounding page script. */
function assignedJson(text: string, assignment: string): unknown {
    const marker = text.indexOf(assignment);
    if (marker < 0) return null;
    const start = text.indexOf('{', marker + assignment.length);
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; start >= 0 && i < text.length; i++) {
        const ch = text[i];
        if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
    }
    return null;
}
export function phenomPublishedJob(html: string, id: string): Record<string, unknown> | null {
    const $ = cheerio.load(html);
    for (const script of $('script').toArray()) {
        const data = assignedJson($(script).text(), 'phApp.ddo =') as { jobDetail?: { data?: { job?: Record<string, unknown> } } } | null;
        const job = data?.jobDetail?.data?.job;
        if (job && [job.jobRequisitionId, job.jobId, job.cmsJobId].includes(id)) return job;
    }
    return null;
}
const validCompany = (v: string) => v.length > 1 && v.length < 200 && /[a-z]/i.test(v) && !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9-]{27})$/i.test(v) && !/^(?:unknown(?: company)?|not specified|not provided|confidential|company name|company logo|header logo|logo|careers?|job(?:s| description)?|ADP|Paycom|Paylocity|Sage HR|Jobvite|CATS|iCIMS|Avature|BrassRing|Talemetry)$/i.test(v);
function taleoPublishedCompany(html: string, url: string): string | null {
    const $ = cheerio.load(html);
    const names = new Set<string>();
    $('a img[alt]').each((_, image) => {
        const alt = $(image).attr('alt')?.trim() || '';
        let source: URL;
        try { source = new URL($(image).attr('src') || '', url); } catch { return; }
        // Employer-theme logos are published branding. Cart/help/social icons
        // and arbitrary alt text cannot establish an employer's identity.
        const themedLogo = source.pathname.startsWith('/careersection/theme/') && /logo/i.test(source.pathname + ' ' + ($(image).attr('class') || '') + ' ' + alt);
        if (!themedLogo && !$(image).closest('a.logo').length) return;
        const name = alt.replace(/\s+logo$/i, '').trim();
        if (validCompany(name) && !/^(?:Oracle|Taleo)$/i.test(name)) names.add(name);
    });
    return names.size === 1 ? [...names][0] : null;
}
/** Published page evidence only. Missing employer or location is never inferred from tenant tokens. */
export function parseBrowserPosting(platform: BrowserAtsPlatform, board: string, link: BrowserPostingLink, docs: BrowserDocument[]): BrowserPosting | null {
    for (const doc of docs) {
        const current = browserPostingLink(platform, board, doc.url);
        if (!current || current.id !== link.id)
            continue;
        const $ = cheerio.load(doc.html);
        if (platform === 'taleo') {
            const publishedId = /Job Number:\s*([^\s)]+)/i.exec(doc.text)?.[1];
            if (publishedId && publishedId !== link.id) continue;
        }
        // Some Talemetry templates emit invalid \$ escapes in otherwise valid JSON-LD.
        const repaired = platform === 'talemetry' ? doc.html.replace(/\\\$/g, '$') : doc.html;
        const structured = extractJsonLdJobPosting(repaired);
        const published = platform === 'phenom' ? phenomPublishedJob(doc.html, link.id) : null;
        if (typeof structured?.url === 'string' && browserPostingLink(platform, board, structured.url)?.id !== link.id)
            continue;
        let title = typeof structured?.title === 'string' ? structured.title.trim() : link.title;
        let company = jsonLdCompanyName(structured?.hiringOrganization);
        let description = typeof structured?.description === 'string' ? cleanBrowserHtml(structured.description) : '';
        let location = structuredBrowserLocation(structured);
        if (structured?.jobLocationType === 'TELECOMMUTE')
            location = ['Remote', location].filter(Boolean).join('; ');
        const metaTitle = $('meta[property="og:title"],meta[name="og:title"]').first().attr('content') || $('head title').first().text();
        if (!title || /^(?:apply(?: now)?|email|view|show more)$/i.test(title))
            title = $('h1,h2').filter((_, n) => !/(?:Home Page|Careers|Search Jobs|^Job Detail$|^Job Description$)/i.test($(n).text().trim())).first().text().trim();
        if (published) {
            if (typeof published.title === 'string') title = published.title;
            if (typeof published.companyName === 'string') company = published.companyName;
            if (typeof published.description === 'string') description = cleanBrowserHtml(published.description);
            const places = Array.isArray(published.multi_location) ? published.multi_location : [];
            location = [...new Set(places.map((place: Record<string, unknown>) => typeof place.address === 'string' ? place.address : [place.city, place.state, place.country].filter(x => typeof x === 'string').join(', ')).filter(Boolean))].join('; ')
                || (typeof published.location === 'string' ? published.location : location);
        }
        if (platform === 'jobvite' && !company) company = /^(.+?) Careers(?: - |$)/.exec($('head title').first().text().trim())?.[1]?.trim() || null;
        if (platform === 'paylocity' && !company) company = $('header #LayoutLogoName,.job-preview-header h2').first().text().trim() || null;
        if (platform === 'cats' && !company) company = $('header #logo img[alt],header img.logo-image[alt]').first().attr('alt')?.trim() || null;
        if (platform === 'taleo' && !company) company = taleoPublishedCompany(doc.html, doc.url);
        if (platform === 'dzconnex' && !company) company = /©\s*\d{4}\s+(.{2,100}?)\.?\s+All Rights Reserved/i.exec(doc.text)?.[1]?.trim() || null;
        if (platform === 'icims' && !company) {
            const m = /at (.+?)(?:\||$)/.exec($('head title').first().text());
            if (m)
                company = m[1].trim();
        }
        if (platform === 'sagehr') {
            const named = metaTitle.endsWith(' - ' + title) ? metaTitle.slice(0, -(' - ' + title).length).trim() : '';
            const other = /Other jobs at (.+)/.exec($('.other-jobs h2').text())?.[1]?.trim();
            const logo = $('img[alt]').toArray().some(n => $(n).attr('alt') === named);
            company = named && (logo || other === named) ? named : other || null;
        }
        if (platform === 'brassring')
            company = metaTitle.split('|').at(-1)?.trim() || null;
        if (platform === 'avature' && !company)
            company = $('img.company__logo[alt]').attr('alt')?.trim() || $('.header__logo h1').first().text().trim() || null;
        if (platform === 'talemetry' && !company)
            company = $('img[alt]').map((_, n) => $(n).attr('alt') || '').get().find(v => / logo$/i.test(v))?.replace(/ logo$/i, '').trim() || null;
        if (platform === 'dzconnex') {
            const heading = $('h2').filter((_, n) => $(n).text().trim() === title).first();
            if (!description)
                description = cleanBrowserHtml(heading.closest('.dmRespCol').html() || '');
            if (!company)
                company = /^([^\n.]{2,100}?) is an equal opportunity employer\./m.exec(description)?.[1]?.trim() || null;
        }
        if (platform === 'taleo' && !company)
            company = /^([^\n.]{2,100}?) \([A-Z]{2,10}\) (?:helps|is|provides|offers)\b/m.exec(doc.text)?.[1]?.trim() || null;
        if (platform === 'cats' && !company) {
            company = /At (.{2,100}?),? (?:a team|we |our )/.exec(doc.text)?.[1] || null;
        }
        if (!description) {
            const selectors: Partial<Record<BrowserAtsPlatform, string>> = {
                jobvite: '.jv-job-detail-description',
                paylocity: '.job-preview-details',
                phenom: '.job-description',
                avature: '.article__content__view,.article__content,.job-description,[itemprop="description"]',
                brassring: '.jobDetailsLiner',
                dzconnex: '.job-description,.job_description,[class*="jobDescription"],[id*="job_description"]',
                taleo: '[id*="requisitionDescription"],[id*="reqDescription"],.job-description',
                sagehr: 'article.block',
                cats: '.job-description,[class*="jobDescription"],[itemprop="description"]',
                talemetry: '.job-details__content-description,.job-description,.job_description,[itemprop="description"]',
            };
            const containers = $(selectors[platform] || '[itemprop="description"]');
            description = platform === 'sagehr' ? containers.toArray().map(n => cleanBrowserHtml($(n).html() || '')).join('\n\n') : containers.toArray().map(n => cleanBrowserHtml($(n).html() || '')).sort((a, b) => b.length - a.length)[0] || '';
        }
        if (!company) {
            const selectors: Partial<Record<BrowserAtsPlatform, string>> = { avature: '.field--company .field__value,[data-field="company"]', dzconnex: '.job-company,.company-name', cats: '.company-name' };
            if (selectors[platform])
                company = $(selectors[platform]!).first().text().trim() || null;
        }
        if (!location) {
            location = $('[itemprop="jobLocation"],.job-location,.jobLocation,[class*="job-location"]').first().text().replace(/\s+/g, ' ').trim();
        }
        if (!location && platform === 'avature') {
            location = $('.tf_getLocationFromCR').text().replace(/^\s*Location\(s\)/, '').replace(/\s+/g, ' ').trim();
            if (!location) location = $('.article__content__view__field').filter((_, n) => /^Location(?:\(s\))?$/.test($(n).find('.article__content__view__field__label').text().trim())).map((_, n) => $(n).find('.article__content__view__field__value').text().trim()).get().filter(Boolean).join('; ');
        }
        if (!location && platform === 'brassring')
            location = $('.jobDetailsLiner').text().match(/\n\s*([^\n]+, [^\n]+)\s*\n/)?.[1]?.trim() || '';
        if (!location && platform === 'talemetry')
            location = /^\s*Location:\s*(.+)$/m.exec(doc.text)?.[1] || '';
        if (!location && platform === 'sagehr')
            location = $('.heading .description').text().trim().split(/\n/).map(x => x.trim()).filter(Boolean).at(-1) || '';
        if (!location && platform === 'cats')
            location = $('.job-header .job-tags li').first().text().trim();
        if (!location && platform === 'taleo')
            location = $('.contentlinepanel').filter((_, n) => /^(?:Primary Location|Work Locations)/.test($(n).text().trim())).map((_, n) => $(n).text().trim()).get().join('; ');
        if (!location && platform === 'dzconnex')
            location = /^\s*Location:\s*(.+)$/m.exec(description)?.[1] || '';
        if (title && company && validCompany(company) && description.length >= 200) {
            const postedAt = typeof structured?.datePosted === 'string' ? new Date(structured.datePosted) : undefined;
            return { ...link, title, company, description, location, ...(postedAt && !Number.isNaN(postedAt.getTime()) ? { postedAt } : {}) };
        }
    }
    return null;
}
