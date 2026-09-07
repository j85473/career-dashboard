type Row = Record<string, unknown>;
export type PaidSearchSource = 'Indeed' | 'Glassdoor (RapidAPI)';
export type PaidSearchDiagnostics = Record<string, string | number | boolean | null>;

function object(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

/** Select a covering provider age bucket; omit the filter for older catch-up. */
export function paidSearchAgeParams(source: PaidSearchSource, windowStart: Date, now: Date): Record<string, string> {
  const days = Math.max(3, Math.ceil((now.getTime() - windowStart.getTime()) / 86_400_000));
  const bucket = [3, 7, 14, 30].find((limit) => days <= limit);
  return bucket ? { [source === 'Indeed' ? 'fromage' : 'fromAge']: String(bucket) } : {};
}

export async function readPaidSearchResponse<T>(
  source: PaidSearchSource,
  response: Response,
  parseRow: (row: Row) => T | null,
  diagnose: (diagnostic: PaidSearchDiagnostics) => void,
): Promise<{ jobs: T[]; rejectedRows: number }> {
  const diagnostic: PaidSearchDiagnostics = { httpStatus: response.status, outcome: 'response_received' };
  if (!response.ok) {
    diagnose({ ...diagnostic, outcome: 'http_error' });
    throw new Error(`${source} HTTP ${response.status}`);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch {
    diagnose({ ...diagnostic, outcome: 'invalid_json' });
    throw new Error(`${source} response schema error: invalid JSON`);
  }
  const root = object(payload);
  const nested = object(root?.data);
  const candidates: Array<[string, unknown]> = source === 'Indeed'
    ? [['hits', root?.hits], ['jobs', root?.jobs], ['data', root?.data]]
    : [['data.jobListings', nested?.jobListings]];
  const match = candidates.find(([, rows]) => Array.isArray(rows));
  if (!root || !match || root.success === false || root.error
    || (typeof root.status === 'string' && /^(error|failed|failure)$/i.test(root.status))) {
    diagnose({ ...diagnostic, outcome: 'schema_error', responseShape: 'missing_or_invalid_job_array' });
    throw new Error(`${source} response schema error: expected a job array without an API error`);
  }
  const rows = match[1] as unknown[];
  const jobs: T[] = [];
  for (const row of rows) {
    const value = object(row);
    const parsed = value ? parseRow(value) : null;
    if (parsed !== null) jobs.push(parsed);
  }
  const rejectedRows = rows.length - jobs.length;
  diagnose({ ...diagnostic, responseShape: match[0], returnedRows: rows.length,
    acceptedRows: jobs.length, rejectedRows,
    outcome: rejectedRows ? 'invalid_rows' : rows.length ? 'parsed_results' : 'empty_results' });
  return { jobs, rejectedRows };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Indeed's own job key, which is what its search rows carry as `id`. Every
 * Indeed row ingested to date has one: 16 hex characters.
 */
const INDEED_JOB_KEY = /^[0-9a-f]{16}$/i;

/**
 * The viewable posting URL for an Indeed job key.
 *
 * Indeed's search response has no `url` field, so `parseIndeedListing` stored
 * an empty string for it and 447 of 456 Indeed rows reached the dashboard with
 * no link at all. That does not stop them being scored — the description call
 * keys on the job key, not the URL — but it leaves both an Action Needed row
 * asking for a manual review with nothing to open, and a scored Inbox row with
 * nothing to apply to. The key alone determines the URL, so no request is
 * needed to recover it.
 */
export function indeedJobUrl(sourceId: string): string {
  return INDEED_JOB_KEY.test(sourceId)
    ? `https://www.indeed.com/viewjob?jk=${sourceId.toLowerCase()}`
    : '';
}

/** Retain the existing Indeed identities, while rejecting unusable rows. */
export function parseIndeedListing(row: Row, now = new Date()) {
  const title = text(row.title) || text(row.job_title);
  const providedUrl = text(row.url) || text(row.job_url);
  const rawId = row.id || row.job_id || row.guid || providedUrl;
  const sourceId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  if (!title || !sourceId) return null;
  const url = providedUrl || indeedJobUrl(sourceId);
  const date = text(row.publication_date);
  return {
    title, sourceId, url, source: 'Indeed',
    company: text(row.company_name) || 'Unknown Company',
    description: text(row.description) || text(row.snippet),
    location: text(row.location) || 'Unknown Location',
    postedAt: date && Number.isFinite(Date.parse(date)) ? new Date(date) : now,
  };
}
