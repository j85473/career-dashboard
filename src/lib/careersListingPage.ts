import { load } from 'cheerio';

/** Positive evidence of a results page, not a vocabulary requirement for JDs. */
export function looksLikeCareersListingPage(value: string): boolean {
  const $ = load(value);
  $('script, style').remove();
  const text = (value.includes('<') ? $.root().text() : value).replace(/\s+/g, ' ').trim();
  const count = /(?:^|[#\s])(?:[2-9]|\d{2,})\s+(?:jobs?|openings?|positions?)\s*[:(]/i.test(text);
  const searchControls = /\b(?:sort by newest|sort by oldest|all locations|search results)\b/i.test(text);
  const pagination = /\b(?:\d+\s+of\s+\d+|\d+\s*-\s*\d+\s+of\s+\d+|\d+\s+rows)\b/i.test(text);
  if (count && searchControls && pagination) return true;
  const title = $('title').text().trim();
  const listingTitle = /^(?:career search|job search|search jobs|careers|job openings|open positions)(?:\s*[|–-].*)?$/i.test(title);
  const postingLinks = new Set($('a[href]').toArray().map(a => $(a).attr('href') || '')
    .filter(href => /(?:[?&](?:ShowJob|jobid)=\d+|\/(?:jobs?|positions?|openings?)\/[^/#?]+)/i.test(href)));
  return listingTitle && postingLinks.size > 1;
}

export class CareersListingPageError extends Error {
  constructor() {
    super('This link opens a careers listing, not one job. Please choose an opening or paste its individual job link.');
    this.name = 'CareersListingPageError';
  }
}
