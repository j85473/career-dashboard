import * as cheerio from 'cheerio';

import { extractJsonLdJobPosting, jsonLdPostingMetadata } from './atsApi';
import { cleanHtmlText } from './jobIngestion';
import { postingMetadataValue, type PostingMetadata } from './postingMetadata';
import { parseUkgPostingHtml } from './ukgPosting';

type PageTitleMetadata = Pick<PostingMetadata, 'title' | 'company'>;

/** Resolve authored posting fields before a new manual card is persisted. */
export async function readManualImportPage(
  input: { html: string; url: string; title?: string; company?: string },
  inferPageTitle: (pageTitle: string, domain: string) => Promise<PageTitleMetadata>,
): Promise<{ title: string; company: string; location?: string; description: string }> {
  const domain = new URL(input.url).hostname.replace(/^www\./i, '');
  const $ = cheerio.load(input.html);
  const posting = extractJsonLdJobPosting(input.html, input.url);
  const metadata = posting ? jsonLdPostingMetadata(posting) : {};
  const ukgPosting = parseUkgPostingHtml(input.html, input.url);
  let title = postingMetadataValue(input.title) || metadata.title || ukgPosting?.title;
  let company = postingMetadataValue(input.company) || metadata.company || ukgPosting?.company;
  const pageTitle = $('title').text().trim();

  // The page's JobPosting metadata is evidence; a model's interpretation of
  // the browser title is only a fallback for fields the posting did not name.
  if ((!title || !company) && pageTitle) {
    try {
      const inferred = await inferPageTitle(pageTitle, domain);
      title ||= postingMetadataValue(inferred.title);
      company ||= postingMetadataValue(inferred.company);
    } catch {
      // Keep any supplied or structured field even when inference fails.
    }
  }

  $('script, style, nav, header, footer').remove();
  return {
    title: title || pageTitle.substring(0, 50) || 'Manual Job Import',
    company: company || domain,
    location: metadata.location || ukgPosting?.location,
    description: ukgPosting?.text || cleanHtmlText($('body').html() || '').substring(0, 5000),
  };
}
