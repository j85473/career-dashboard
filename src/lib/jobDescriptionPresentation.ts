import { cleanHtmlText } from './jobIngestion';
import { cleanJobDescriptionPage } from './jobDescriptionCleanup';

const DESCRIPTION_MARKUP = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>|&(?:lt|gt|amp|quot|apos|nbsp|#[0-9]+|#x[a-f0-9]+);/i;

/**
 * Historical descriptions can still contain provider HTML. Present readable
 * paragraphs and bullets without changing the saved JD or score authority.
 * Plain text bypasses the HTML parser so its whitespace and comparisons stay
 * exactly as authored. The shared cleaner also handles escaped HTML.
 */
export function presentJobDescription<T extends { description?: string | null }>(job: T): T {
  if (!job.description) return job;
  let description = cleanJobDescriptionPage(job.description);
  if (description === job.description && !DESCRIPTION_MARKUP.test(description)) return job;
  for (let pass = 0; pass < 3 && DESCRIPTION_MARKUP.test(description); pass += 1) {
    const cleaned = cleanHtmlText(description);
    if (cleaned === description) break;
    description = cleaned;
  }
  return { ...job, description };
}
