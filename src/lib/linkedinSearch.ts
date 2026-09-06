type Row = Record<string, unknown>;
type Diagnostic = Record<string, string | number | boolean | null>;
export type LinkedInSearchProgress = {
  version: 1; query: string; lane: string; windowStart: string; windowEnd: string;
  cursor: string; complete: boolean;
};
const DAY_MS = 86_400_000;
const PAGE_SIZE = 20;
function object(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

export function readLinkedInSearchProgress(value: unknown): LinkedInSearchProgress | null {
  const p = object(object(value)?.linkedin);
  return p?.version === 1 && typeof p.query === 'string' && typeof p.lane === 'string'
    && typeof p.windowStart === 'string' && Number.isFinite(Date.parse(p.windowStart))
    && typeof p.windowEnd === 'string' && Number.isFinite(Date.parse(p.windowEnd))
    && Date.parse(p.windowStart) <= Date.parse(p.windowEnd)
    && typeof p.cursor === 'string' && /^\d+$/.test(p.cursor) && typeof p.complete === 'boolean'
    ? p as LinkedInSearchProgress : null;
}

export function newLinkedInSearchProgress(query: string, lane: string, start: Date, end: Date): LinkedInSearchProgress {
  return { version: 1, query, lane, windowStart: start.toISOString(), windowEnd: end.toISOString(), cursor: '0', complete: false };
}

/** Provider location names and work-arrangement filters never enter the title. */
export function linkedInSearchParams(progress: LinkedInSearchProgress, now = new Date()): URLSearchParams {
  const location = progress.lane === 'msp_metro'
    ? '"Minneapolis, Minnesota, United States" OR "Saint Paul, Minnesota, United States"'
    : progress.lane === 'minnesota' ? 'Minnesota, United States'
    : progress.lane === 'upper_midwest'
      ? ['Minnesota', 'Wisconsin', 'Iowa', 'North Dakota', 'South Dakota'].map((state) => `"${state}, United States"`).join(' OR ')
    : progress.lane === 'us_remote' ? 'United States' : null;
  if (!location) throw new Error('Unsupported LinkedIn geography lane');
  return new URLSearchParams({
    title: progress.query, location, source: 'linkedin', description_format: 'text',
    // Broaden the feed window when resuming old work; the exact indexed-time
    // bounds stay frozen so cursor pagination covers the assigned interval.
    time_frame: now.getTime() - Date.parse(progress.windowStart) <= 7 * DAY_MS ? '7d' : '6m',
    date_created_gte: progress.windowStart, date_created_lt: progress.windowEnd,
    cursor: progress.cursor, limit: String(PAGE_SIZE),
    ...(progress.lane === 'us_remote' ? { ai_work_arrangement: 'Remote Solely,Remote OK' } : {}),
  });
}

export function parseLinkedInJob(row: Row) {
  const sourceId = typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id) : '';
  const title = text(row.title);
  const url = text(row.url) || text(row.job_url);
  if (!/^\d+$/.test(sourceId) || !title || !url) return null;
  const company = object(row.company);
  const derived = Array.isArray(row.locations_derived) ? row.locations_derived.map(text).filter(Boolean) : [];
  const postedDate = text(row.date_posted) || text(row.posted_date);
  return { title, url, sourceId, source: 'LinkedIn',
    company: text(row.organization) || text(company?.name) || text(row.company_name) || 'Unknown Company',
    description: text(row.description_text) || text(row.description),
    location: derived.join('; ') || text(row.location) || 'Unknown Location',
    postedAt: postedDate && Number.isFinite(Date.parse(postedDate)) ? new Date(postedDate) : new Date(),
  };
}

/** Persist only completed pages; a budget wait or processing failure replays safely. */
export async function runLinkedInSearch(input: {
  progress: LinkedInSearchProgress;
  fetchPage: (params: URLSearchParams) => Promise<Response>;
  processJob: (job: NonNullable<ReturnType<typeof parseLinkedInJob>>) => Promise<void>;
  checkpoint: (progress: LinkedInSearchProgress) => Promise<void>;
  diagnose: (diagnostic: Diagnostic) => void;
  signal?: AbortSignal;
  now?: () => Date;
  maxPages?: number;
}): Promise<LinkedInSearchProgress> {
  let progress = { ...input.progress };
  for (let page = 0; page < (input.maxPages ?? 5) && !progress.complete; page++) {
    input.signal?.throwIfAborted();
    const response = await input.fetchPage(linkedInSearchParams(progress, input.now?.()));
    if (!response.ok) {
      input.diagnose({ outcome: 'http_error', httpStatus: response.status });
      throw new Error(`LinkedIn HTTP ${response.status}`);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch {
      input.diagnose({ outcome: 'invalid_json', httpStatus: response.status });
      throw new Error('LinkedIn response schema error: invalid JSON');
    }
    if (!Array.isArray(payload)) {
      input.diagnose({ outcome: 'schema_error', httpStatus: response.status });
      throw new Error('LinkedIn response schema error: expected an array of jobs');
    }
    const rows = payload.map((row) => object(row)).map((row) => row ? parseLinkedInJob(row) : null);
    const rejectedRows = rows.filter((row) => row === null).length;
    input.diagnose({ outcome: rejectedRows ? 'invalid_rows' : rows.length ? 'parsed_results' : 'empty_results',
      httpStatus: response.status, returnedRows: rows.length, rejectedRows, acceptedRows: rows.length - rejectedRows });
    if (rejectedRows) throw new Error(`LinkedIn response schema error: ${rejectedRows} unusable rows`);
    let cursor = progress.cursor;
    for (const row of rows) {
      if (!row) continue;
      if (BigInt(row.sourceId) <= BigInt(cursor)) throw new Error('LinkedIn pagination cursor did not advance in ID order');
      cursor = row.sourceId;
    }
    for (const row of rows) {
      input.signal?.throwIfAborted();
      if (row) await input.processJob(row);
    }
    input.signal?.throwIfAborted();
    progress = { ...progress, cursor, complete: rows.length < PAGE_SIZE };
    await input.checkpoint(progress);
  }
  return progress;
}
