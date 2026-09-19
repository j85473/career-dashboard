/**
 * Reading an Adzuna posting's full text from its `/details/<id>` page.
 *
 * Adzuna's API truncates `description` at 500 characters, and the URL it hands
 * back — `/land/ad/<id>` — is an interstitial. Every fetch of that interstitial
 * now fails: from the M70 and the Mac it is a CloudFront 403 for the whole site
 * (the stealth browser included), and through the Jina reader it is Adzuna's
 * "suspicious behaviour" wall. So JD recovery read an error page three times
 * and dismissed the job.
 *
 * The same ad's `/details/<id>` page, read through Jina, carries the complete
 * posting. It is also where Adzuna says a listing has expired. The ad id is the
 * row's `sourceId`, so no redirect needs to be followed to find it.
 *
 * The page arrives wrapped in site furniture: the search bar, salary widgets,
 * "Similar jobs", and a large footer of popular searches. Left in, that chrome
 * alone clears the length gate, so a page with no posting body would look like
 * a successful recovery. `extractAdzunaPostingText` therefore returns only the
 * posting, and an empty string when there is none.
 */

const ADZUNA_SOURCE = 'adzuna';
const AD_ID_IN_URL = /adzuna\.[a-z.]+\/(?:land\/ad|details)\/(\d{5,})/i;

export function adzunaDetailsUrl(job: {
  source?: string | null;
  sourceId?: string | null;
  url?: string | null;
}): string | null {
  if (String(job.source || '').trim().toLowerCase() !== ADZUNA_SOURCE) return null;
  const sourceId = String(job.sourceId || '').trim();
  const id = /^\d{5,}$/.test(sourceId) ? sourceId : String(job.url || '').match(AD_ID_IN_URL)?.[1];
  return id ? `https://www.adzuna.com/details/${id}` : null;
}

const EXPIRED_NOTICE = /unfortunately,?\s+this job is no longer available/i;

/**
 * Where the posting ends. A live listing is followed by "Stats for this job"
 * or "Similar jobs"; an expired one runs straight into the footer's
 * "Top job titles".
 */
const POSTING_END = /^(?:#{2,4}\s+(?:Stats for this job|Similar jobs|Popular searches|Top job titles)\b|Popular Jobs\b)/i;

const CHROME_LINE = [
  /back to last search/i,
  /^apply for this job$/i,
  /per year - estimated/i,
  /^new$/i,
  /^remote$/i,
];

export function extractAdzunaPostingText(markdown: string | null | undefined): string {
  const raw = String(markdown || '');
  const lines = raw.split('\n');
  const heading = lines.findIndex((line) => /^# \S/.test(line));
  if (heading < 0) return '';
  const endOffset = lines.slice(heading + 1).findIndex((line) => POSTING_END.test(line.trim()));
  const bodyLines = endOffset < 0 ? lines.slice(heading + 1) : lines.slice(heading + 1, heading + 1 + endOffset);

  const body = bodyLines
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    // The apply button sits on the same line as the posting's first or last
    // sentence once its link is stripped.
    .map((line) => line.replace(/^\s*Apply for this job/i, '').replace(/Apply for this job\s*$/i, '').trimEnd())
    .filter((line) => !CHROME_LINE.some((pattern) => pattern.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Adzuna keeps an expired posting's text on the page under this notice.
  // Leading with the notice lets the closed-posting check dismiss it as
  // closed instead of scoring a job that can no longer be applied to.
  if (EXPIRED_NOTICE.test(raw)) return `Unfortunately, this job is no longer available.\n\n${body}`.trim();
  return body;
}
