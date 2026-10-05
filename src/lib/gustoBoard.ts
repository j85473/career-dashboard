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

export function isGustoClosedBoardPage(visibleText: string, hasPostingLinks: boolean): boolean {
  // Gusto's HTML includes hidden setup and style text before the closed-board
  // notice. Use the rendered visible body text, not Cheerio's raw body text.
  const normalized = visibleText.replace(/\s+/g, ' ').trim();
  return !hasPostingLinks && /^This job board is closed\.(?:\s|$)/i.test(normalized);
}

export function isGustoSetupBoardPage(visibleText: string, hasPostingLinks: boolean): boolean {
  const normalized = visibleText.replace(/\s+/g, ' ').trim();
  return !hasPostingLinks && /^Just a few more steps to go\. This account is still being set up\.(?:\s|$)/i.test(normalized);
}

export function isGustoMissingPage(visibleText: string): boolean {
  return /^404 ERROR\s+Oh no! We can't find the page you're looking for\./i.test(visibleText.replace(/\s+/g, ' ').trim());
}

export function parseGustoBoardSnapshot(html: string, visibleText: string, slug: string): (GustoBoardListing & { unavailableReason?: 'closed' | 'setup' }) | null {
  if (!gustoBoardIdFromSlug(slug)) return null;
  const $ = cheerio.load(html);
  const hasPostingLinks = $('a[href]').toArray().some((anchor) => gustoPostingIdFromUrl($(anchor).attr('href') || ''));
  if (isGustoClosedBoardPage(visibleText, hasPostingLinks)) return { company: '', postings: [], unavailableReason: 'closed' };
  if (isGustoSetupBoardPage(visibleText, hasPostingLinks)) return { company: '', postings: [], unavailableReason: 'setup' };
  return parseGustoBoardHtml(html, slug);
}

export function parseGustoBoardHtml(html: string, slug: string): GustoBoardListing | null {
  if (!gustoBoardIdFromSlug(slug)) return null;
  const $ = cheerio.load(html);
  // Current Gusto boards place the employer heading inside a plain centered
  // container; there is no stable job-board-header class on the page.
  const company = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const headings = $('h1,h2,h3,h4,h5,h6').toArray().map((node) => $(node).text().replace(/\s+/g, ' ').trim().toLowerCase());
  const hasPositionsHeading = headings.includes('open positions');
  const hasEmptyHeading = headings.includes('there are no open positions currently');
  if (!company || company.toLowerCase() === 'open positions' || (!hasPositionsHeading && !hasEmptyHeading)) return null;

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
  if (hasEmptyHeading && postings.size > 0) return null;
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

/** The reader preserves Gusto's authored sections when its HTML page blocks a direct fetch. */
export function parseGustoReaderMarkdown(markdown: string, postingUrl: string): Pick<GustoPosting, 'title' | 'company' | 'description'> | null {
  const requestedId = gustoPostingIdFromUrl(postingUrl);
  const sourceUrl = /^URL Source:\s*(\S+)/m.exec(markdown)?.[1];
  const titleLine = /^Title:\s*(.+?)\s+at\s+(.+)$/m.exec(markdown);
  const content = /^Markdown Content:\s*\n([\s\S]+)$/m.exec(markdown)?.[1]?.trim();
  if (!requestedId || !sourceUrl || gustoPostingIdFromUrl(sourceUrl) !== requestedId || !titleLine || !content) return null;
  const title = titleLine[1].trim();
  const company = titleLine[2].trim();
  if (!title || !company) return null;
  const description = content
    .replace(/^\*\*(.+)\*\*$/gm, '$1')
    .replace(/^\*\s+/gm, '• ')
    .replace(/^_([^\n]+)_$/gm, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, company, description };
}

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
  // Employer-authored text can contain its own Description heading. Choose
  // the provider's section wrapper, never a heading inside the rich text.
  const descriptionHeading = $('h1,h2,h3,h4,h5,h6').toArray().find((node) =>
    $(node).text().trim().toLowerCase() === 'description'
    && $(node).parents('.rich-text-container').length === 0
    && $(node).parent().find('.rich-text-container').length > 0);
  const descriptionHtml = descriptionHeading
    ? $(descriptionHeading).parent().find('.rich-text-container').first().html()?.trim() || ''
    : '';
  if (!company || !title || !descriptionHtml) return null;
  const richText = cheerio.load(descriptionHtml);
  richText('script, style, template').remove();
  richText('br').replaceWith('\n');
  richText('h1, h2, h3, h4, h5, h6').each((_index, heading) => {
    richText(heading).prepend('\n\n').append('\n');
  });
  richText('p').append('\n\n');
  richText('li').prepend('• ').append('\n');
  const formattedDescription = richText.root().text()
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const location = (locationAndType || '').split('·')[0].trim() || 'Unknown Location';
  const summary = $('h1').first().parent().children('div.text-gray-800').first().text().trim();
  const salaryHeading = $('h4').toArray().find((node) => $(node).text().trim().toLowerCase() === 'salary');
  const salary = salaryHeading ? $(salaryHeading).nextAll('p').first().text().trim() : '';
  const description = [summary, formattedDescription, salary ? `Salary: ${salary}` : ''].filter(Boolean).join('\n\n');
  return { id, title, company, location, description, url: new URL(postingUrl).toString() };
}
