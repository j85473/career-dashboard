import { directAtsTitleKey, type BoardPosting } from './atsDirectMatch';
import { cleanHtmlText, generatePostingIdentity } from './jobIngestion';
import { workdayDetailLocation } from './workdayLocation';
import { workdayHiringOrganizationName } from './workdayCompany';
import { sameEmployer } from './employerIdentity';

type ReadJson = (url: string, init?: RequestInit) => Promise<unknown>;
type Row = Record<string, unknown>;
const object = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const GENERIC_TITLE_WORDS = new Set(['senior', 'junior', 'manager', 'director', 'business', 'development',
  'account', 'accounts', 'sales', 'remote', 'eligible', 'lead', 'leader', 'specialist', 'executive',
  'associate', 'assistant', 'regional', 'territory', 'national', 'global', 'the', 'and', 'of']);

export function workdayMatchSearchText(title: string): string {
  const words = directAtsTitleKey(title).split(' ').filter(word => /^[a-z0-9]{3,}$/.test(word));
  // CXS uses OR between words on some tenants. A distinctive word that every
  // exact title must contain avoids downloading the entire employer for
  // "Business Development Manager, Luxury Travel" while retaining all rivals.
  return [...words.filter(word => !GENERIC_TITLE_WORDS.has(word)), ...words]
    .sort((a, b) => Number(GENERIC_TITLE_WORDS.has(a)) - Number(GENERIC_TITLE_WORDS.has(b)) || b.length - a.length)[0] || '';
}

/** Complete title search followed by exact details; never match a partial page. */
export async function fetchWorkdayMatchPostings(
  slug: string,
  job: { title: string; company: string },
  read: ReadJson,
): Promise<BoardPosting[] | null> {
  const identity = /^([a-z0-9-]+)\.(wd\d+)::([a-z0-9_-]+)$/i.exec(slug);
  const title = directAtsTitleKey(job.title);
  if (!identity || !title) return null;
  const [, tenant, shard, site] = identity;
  const origin = `https://${tenant}.${shard}.myworkdayjobs.com`;
  const api = `${origin}/wday/cxs/${tenant}/${site}`;
  const rows = new Map<string, Row>();
  let expectedTotal: number | undefined;
  for (let offset = 0; offset < 200; offset += 20) {
    const body = object(await read(`${api}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: workdayMatchSearchText(job.title) }),
    }));
    if (!body || !Array.isArray(body.jobPostings) || !Number.isSafeInteger(body.total)
      || Number(body.total) < 0 || Number(body.total) > 200) return null;
    if (expectedTotal !== undefined && expectedTotal !== body.total) return null;
    expectedTotal = Number(body.total);
    if (body.jobPostings.length !== Math.min(20, Math.max(0, expectedTotal - offset))) return null;
    for (const raw of body.jobPostings) {
      const row = object(raw);
      if (!row || typeof row.title !== 'string' || !row.title.trim()
        || typeof row.externalPath !== 'string' || !/^\/job\/[^?#]+$/.test(row.externalPath)
        || rows.has(row.externalPath)) return null;
      const target = new URL(`${api}${row.externalPath}`);
      if (!target.href.startsWith(`${api}/job/`)) return null;
      rows.set(row.externalPath, row);
    }
    if (rows.size === expectedTotal) break;
  }
  if (rows.size !== expectedTotal) return null;
  // A title search proves completeness for title matches only. Do not use a
  // differently named result as description-only evidence from this subset.
  const candidates = [...rows.entries()].filter(([, row]) => directAtsTitleKey(String(row.title)) === title);
  if (candidates.length > 25) return null;
  const postings: BoardPosting[] = [];
  for (const [path, row] of candidates) {
    const body = object(await read(`${api}${path}`));
    const detail = object(body?.jobPostingInfo);
    const employer = workdayHiringOrganizationName(body?.hiringOrganization);
    const url = `${origin}/en-US/${site}${path}`;
    if (!detail || detail.title !== row.title || typeof detail.jobDescription !== 'string'
      || !detail.jobDescription.trim()) return null;
    const publishedUrl = typeof detail.externalUrl === 'string' ? detail.externalUrl : null;
    if (publishedUrl && generatePostingIdentity({ url: publishedUrl }) !== generatePostingIdentity({ url })) return null;
    if (!publishedUrl && !(typeof detail.jobReqId === 'string' && Array.isArray(row.bulletFields)
      && row.bulletFields.includes(detail.jobReqId))) return null;
    // A tenant may publish for several subsidiaries. An explicit different
    // hiring organization cannot become this employer's candidate.
    if (employer && !sameEmployer({ company: employer }, { company: job.company })) continue;
    postings.push({ title: String(detail.title), url,
      location: workdayDetailLocation(detail), description: cleanHtmlText(detail.jobDescription) });
  }
  return postings;
}
