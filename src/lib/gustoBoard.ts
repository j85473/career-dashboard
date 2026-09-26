import * as cheerio from 'cheerio';

const GUSTO_HOST = 'jobs.gusto.com';
const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function gustoPath(value: string, kind: 'boards' | 'postings'): string | null {
  try {
    const url = new URL(value, `https://${GUSTO_HOST}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== GUSTO_HOST) return null;
    const match = new RegExp(`^/${kind}/([^/]+?)/?$`, 'i').exec(url.pathname);
    return match && UUID_SUFFIX.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

export function gustoBoardSlugFromUrl(value: string): string | null {
  return gustoPath(value, 'boards');
}

export function gustoPostingIdFromUrl(value: string): string | null {
  const path = gustoPath(value, 'postings');
  return path ? UUID_SUFFIX.exec(path)?.[1]?.toLowerCase() || null : null;
}

export function gustoBoardIdFromSlug(slug: string): string | null {
  return gustoBoardSlugFromUrl(`https://${GUSTO_HOST}/boards/${slug}`)
    ? UUID_SUFFIX.exec(slug)?.[1]?.toLowerCase() || null
    : null;
}

export function gustoBoardUrl(slug: string): string | null {
  return gustoBoardIdFromSlug(slug) ? `https://${GUSTO_HOST}/boards/${slug}` : null;
}

export type GustoBoardListing = {
  company: string;
  postings: Array<{ id: string; title: string; location: string; url: string }>;
};

export function parseGustoBoardHtml(html: string, slug: string): GustoBoardListing | null {
  if (!gustoBoardIdFromSlug(slug)) return null;
  const $ = cheerio.load(html);
  const company = $('.job-board-header h1').first().text().trim();
  const hasPositionsHeading = $('h1,h2').toArray()
    .some((node) => $(node).text().trim().toLowerCase() === 'open positions');
  if (!company || !hasPositionsHeading) return null;

  const postings = new Map<string, GustoBoardListing['postings'][number]>();
  $('a[href]').each((_index, anchor) => {
    const raw = $(anchor).attr('href') || '';
    const id = gustoPostingIdFromUrl(raw);
    const title = $(anchor).find('h3').first().text().trim();
    if (!id || !title) return;
    const url = new URL(raw, `https://${GUSTO_HOST}`).toString();
    const location = $(anchor).find('p').first().text().replace(/\s+/g, ' ').trim();
    postings.set(id, { id, title, location, url });
  });
  return { company, postings: [...postings.values()] };
}

export type GustoPosting = {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
};

export function parseGustoPostingHtml(html: string, postingUrl: string, expectedBoardSlug: string): GustoPosting | null {
  const id = gustoPostingIdFromUrl(postingUrl);
  const boardId = gustoBoardIdFromSlug(expectedBoardSlug);
  if (!id || !boardId) return null;
  const $ = cheerio.load(html);
  const belongsToBoard = $('a[href]').toArray().some((anchor) => {
    const href = $(anchor).attr('href') || '';
    const linkedSlug = gustoBoardSlugFromUrl(href);
    return linkedSlug && gustoBoardIdFromSlug(linkedSlug) === boardId;
  });
  if (!belongsToBoard) return null;

  const headingSpans = $('h1').first().children('span').toArray().map((span) => $(span).text().replace(/\s+/g, ' ').trim());
  const [company, title, locationAndType] = headingSpans;
  const descriptionHeading = $('h3').toArray().find((node) => $(node).text().trim().toLowerCase() === 'description');
  const descriptionHtml = descriptionHeading
    ? $(descriptionHeading).parent().find('.rich-text-container').first().html()?.trim() || ''
    : '';
  if (!company || !title || !descriptionHtml) return null;
  const location = (locationAndType || '').split('·')[0].trim() || 'Unknown Location';
  const summary = $('h1').first().parent().children('div.text-gray-800').first().text().trim();
  const salaryHeading = $('h4').toArray().find((node) => $(node).text().trim().toLowerCase() === 'salary');
  const salary = salaryHeading ? $(salaryHeading).nextAll('p').first().text().trim() : '';
  const description = [summary, descriptionHtml, salary ? `Salary: ${salary}` : ''].filter(Boolean).join('\n\n');
  return { id, title, company, location, description, url: new URL(postingUrl).toString() };
}
