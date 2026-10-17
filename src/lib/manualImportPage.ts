import { isGenericManualImportTitle, manualImportCompanyValue } from './manualImportPolicy';
import * as cheerio from 'cheerio';

import { extractJsonLdJobPosting, jsonLdPageMetadata } from './atsApi';
import { cleanHtmlText } from './jobIngestion';
import { postingMetadataValue, type PostingMetadata } from './postingMetadata';
import { parseUkgPostingHtml } from './ukgPosting';
import { CareersListingPageError, looksLikeCareersListingPage } from './careersListingPage';
import { looksLikeSiteConfiguration } from './jobDescriptionQuality';
import { eightfoldPostingPageMetadata } from './eightfoldBoard';

type PageTitleMetadata = Pick<PostingMetadata, 'title' | 'company'>;

/** Resolve authored posting fields before a new manual card is persisted. */
export async function readManualImportPage(
  input: { html: string; url: string; title?: string; company?: string },
  inferPageTitle: (pageTitle: string, domain: string) => Promise<PageTitleMetadata>,
): Promise<{ title: string; company: string; location?: string; description: string }> {
  const domain = new URL(input.url).hostname.replace(/^www\./i, '');
  const $ = cheerio.load(input.html);
  const posting = extractJsonLdJobPosting(input.html, input.url);
  if (!posting && looksLikeCareersListingPage(input.html)) throw new CareersListingPageError();
  const metadata = { ...(posting ? jsonLdPageMetadata(posting, input.html) : {}), ...eightfoldPostingPageMetadata(input.url, input.html) };
  const ukgPosting = parseUkgPostingHtml(input.html, input.url);
  let title = postingMetadataValue(input.title) || metadata.title || ukgPosting?.title;
  let company = postingMetadataValue(input.company) || manualImportCompanyValue(metadata.company, input.url) || manualImportCompanyValue(ukgPosting?.company, input.url);
  const pageTitle = $('title').text().trim();

  // The page's JobPosting metadata is evidence; a model's interpretation of
  // the browser title is only a fallback for fields the posting did not name.
  if ((!title || !company) && pageTitle && !isGenericManualImportTitle(pageTitle)) {
    try {
      const inferred = await inferPageTitle(pageTitle, domain);
      title ||= postingMetadataValue(inferred.title);
      company ||= manualImportCompanyValue(inferred.company, input.url);
    } catch {
      // Keep any supplied or structured field even when inference fails.
    }
  }

  $('script, style, template, nav, header, footer, [hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"]').remove();
  const description = ukgPosting?.text || (typeof posting?.description === 'string' ? cleanHtmlText(posting.description) : '')
    || cleanHtmlText($('body').html() || '');
  return {
    title: title && !isGenericManualImportTitle(title) ? title : (!isGenericManualImportTitle(pageTitle) ? pageTitle : '') || 'Manual Job Import',
    company: company || 'Unknown Company',
    location: metadata.location || ukgPosting?.location,
    description: looksLikeSiteConfiguration(description) ? '' : description,
  };
}
