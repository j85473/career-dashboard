/** JSearch's cursor contract, bounded catch-up and safe response diagnostics. */
const DAY_MS = 86_400_000;
export type JSearchDateFilter = 'today' | '3days' | 'week' | 'month' | 'all';
export type JSearchProgress = {
  version: 1;
  query: string;
  windowStart: string;
  windowEnd: string;
  datePosted: JSearchDateFilter;
  cursor: string | null;
  pages: number;
  complete: boolean;
};
export type JSearchDiagnostics = Record<string, string | number | boolean | null>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Ask for a superset of the assigned interval; retain the normal dedupe rules. */
export function jsearchDateFilter(windowStart: Date, now: Date): JSearchDateFilter {
  const age = Math.max(0, now.getTime() - windowStart.getTime());
  // Daily scheduling plus overlap routinely exceeds 24h. Give even a fresh
  // search a three-day indexing cushion instead of depending on "today".
  if (age <= 3 * DAY_MS) return '3days';
  if (age <= 7 * DAY_MS) return 'week';
  if (age <= 30 * DAY_MS) return 'month';
  return 'all';
}

export function readJSearchProgress(value: unknown): JSearchProgress | null {
  const saved = record(record(value)?.jsearch);
  if (!saved || saved.version !== 1 || typeof saved.query !== 'string'
    || typeof saved.windowStart !== 'string' || typeof saved.windowEnd !== 'string'
    || !Number.isFinite(Date.parse(saved.windowStart)) || !Number.isFinite(Date.parse(saved.windowEnd))
    || Date.parse(saved.windowStart) > Date.parse(saved.windowEnd)
    || !['today', '3days', 'week', 'month', 'all'].includes(String(saved.datePosted))
    || !(saved.cursor === null || typeof saved.cursor === 'string')
    || !Number.isSafeInteger(saved.pages) || Number(saved.pages) < 0
    || typeof saved.complete !== 'boolean') return null;
  return saved as JSearchProgress;
}

export function newJSearchProgress(query: string, windowStart: Date, windowEnd: Date, now: Date): JSearchProgress {
  return { version: 1, query, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
    datePosted: jsearchDateFilter(windowStart, now), cursor: null, pages: 0, complete: false };
}

export class JSearchResponseError extends Error {
  constructor(message: string, readonly diagnostics: JSearchDiagnostics) {
    super(message);
    this.name = 'JSearchResponseError';
  }
}

export function parseJSearchResponse(payload: unknown, httpStatus: number) {
  const root = record(payload);
  const data = record(root?.data);
  const diagnostic: JSearchDiagnostics = {
    httpStatus,
    apiStatus: typeof root?.status === 'string' ? root.status.slice(0, 40) : null,
    // Only names/counts, never payloads, credentials, descriptions or cursors.
    responseShape: !root ? 'non_object' : !data ? 'data_not_object'
      : !Array.isArray(data.jobs) ? 'jobs_not_array' : 'data.jobs',
    returnedRows: Array.isArray(data?.jobs) ? data.jobs.length : 0,
    cursorPresent: typeof data?.cursor === 'string' && data.cursor.length > 0,
    rejectedRows: 0,
    acceptedRows: 0,
  };
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new JSearchResponseError(`JSearch HTTP ${httpStatus}`, { ...diagnostic, outcome: 'http_error' });
  }
  if (root?.status !== 'OK' || !data || !Array.isArray(data.jobs)
    || (data.cursor != null && typeof data.cursor !== 'string')) {
    throw new JSearchResponseError('JSearch response schema mismatch; expected status OK and data.jobs with a string or null cursor.',
      { ...diagnostic, outcome: 'schema_error' });
  }
  return { jobs: data.jobs as unknown[], cursor: (data.cursor as string | null) || null, diagnostic };
}

/** Checkpoint only after every row is handled, so interruption safely replays a page. */
export async function runJSearchPages<T>(input: {
  progress: JSearchProgress;
  fetchPage: (params: URLSearchParams) => Promise<Response>;
  parseJob: (row: Record<string, unknown>) => T | null;
  processJob: (job: T) => Promise<unknown>;
  checkpoint: (progress: JSearchProgress) => Promise<void>;
  diagnose: (diagnostics: JSearchDiagnostics) => void;
  signal?: AbortSignal;
  maxPages?: number;
}): Promise<JSearchProgress> {
  let progress = { ...input.progress };
  const cursors = new Set<string>();
  if (progress.cursor) cursors.add(progress.cursor);
  for (let page = 0; page < (input.maxPages ?? 5) && !progress.complete; page++) {
    input.signal?.throwIfAborted();
    const params = new URLSearchParams({ query: progress.query, date_posted: progress.datePosted });
    if (progress.cursor) params.set('cursor', progress.cursor);
    let diagnostic: JSearchDiagnostics = { page: progress.pages + 1, datePosted: progress.datePosted, outcome: 'request_started' };
    input.diagnose(diagnostic);
    try {
      const response = await input.fetchPage(params);
      let payload: unknown;
      try { payload = await response.json(); } catch {
        throw new JSearchResponseError(`JSearch HTTP ${response.status}: response was not valid JSON.`,
          { httpStatus: response.status, outcome: 'invalid_json' });
      }
      const result = parseJSearchResponse(payload, response.status);
      diagnostic = { ...diagnostic, ...result.diagnostic };
      const parsed = result.jobs.map((row) => {
        const object = record(row);
        return object ? input.parseJob(object) : null;
      });
      diagnostic.rejectedRows = parsed.filter((row) => row === null).length;
      diagnostic.acceptedRows = parsed.length - Number(diagnostic.rejectedRows);
      // Process valid rows even in a mixed malformed page, then retain the page
      // for retry. A bad row must not masquerade as an empty completed search.
      for (const job of parsed) {
        input.signal?.throwIfAborted();
        if (job !== null) await input.processJob(job);
      }
      input.signal?.throwIfAborted();
      if (diagnostic.rejectedRows) {
        throw new JSearchResponseError(`JSearch rejected ${diagnostic.rejectedRows} of ${result.jobs.length} returned rows: missing title or stable job_uid.`,
          { ...diagnostic, outcome: 'invalid_rows' });
      }
      if (result.cursor && cursors.has(result.cursor)) {
        throw new JSearchResponseError('JSearch returned a repeated pagination cursor.', { ...diagnostic, outcome: 'repeated_cursor' });
      }
      diagnostic.outcome = result.jobs.length === 0 ? 'empty_results' : 'parsed_results';
      input.diagnose(diagnostic);
      progress = { ...progress, cursor: result.cursor, pages: progress.pages + 1, complete: !result.cursor };
      await input.checkpoint(progress);
      if (result.cursor) cursors.add(result.cursor);
    } catch (error) {
      input.diagnose(error instanceof JSearchResponseError
        ? { ...diagnostic, ...error.diagnostics }
        : { ...diagnostic, outcome: error instanceof Error && /blocked by .*budget/.test(error.message)
          ? 'budget_wait' : input.signal?.aborted ? 'interrupted' : 'request_or_processing_error' });
      throw error;
    }
  }
  return progress;
}
