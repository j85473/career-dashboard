import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';

const DATA_ORIGIN = 'https://data.commoncrawl.org';
const HEADERS = { 'User-Agent': 'CareerDashboard-CommonCrawl-local/1.0', 'Accept-Encoding': 'identity' };
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024;
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
export type LocalCrawlPattern = { platform: string; pattern: string };
export type LocalCrawlBlock = {
  key: string; endKey: string | null; shard: string; offset: number; length: number; patterns: number[];
};
export type LocalCrawlPlan = {
  version: 1; indexId: string; manifestSha256: string; directoryBytes: number;
  patterns: LocalCrawlPattern[]; blocks: LocalCrawlBlock[]; compressedBytes: number;
};
export type LocalCrawlConfig = { mount: string; workspace: string; reserveBytes: number; delayMs: number };

export function localCrawlConfig(env: Record<string, string | undefined> = process.env): LocalCrawlConfig {
  const mount = path.resolve(env.ATS_DISCOVERY_LOCAL_MOUNT || '/media/nas');
  if (mount === path.parse(mount).root) throw new Error('Common Crawl scratch must use a dedicated mounted drive.');
  const reserveBytes = Number(env.ATS_DISCOVERY_LOCAL_RESERVE_BYTES || 20 * 1024 ** 3);
  const delayMs = Number(env.ATS_DISCOVERY_LOCAL_DELAY_MS || 1000);
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 1024 ** 3) throw new Error('Keep at least 1 GiB free on the scratch drive.');
  if (!Number.isSafeInteger(delayMs) || delayMs < 1000) throw new Error('Direct-file requests must be at least 1000ms apart.');
  return { mount, workspace: path.join(mount, 'career-dashboard-commoncrawl'), reserveBytes, delayMs };
}

/** Refuse a missing mount; never silently fill the OS disk underneath it. */
export async function prepareLocalCrawlWorkspace(config: LocalCrawlConfig): Promise<void> {
  const mounted = await realpath(config.mount);
  if (mounted !== config.mount || (await stat(mounted)).dev === (await stat(path.dirname(mounted))).dev) {
    throw new Error(`Common Crawl requires a real mounted drive at ${config.mount}.`);
  }
  await mkdir(config.workspace, { recursive: true, mode: 0o700 });
  if (await realpath(config.workspace) !== config.workspace) throw new Error('Common Crawl scratch must not be a symbolic link.');
  await requireLocalCrawlSpace(config, MAX_DIRECTORY_BYTES);
}

export async function requireLocalCrawlSpace(config: LocalCrawlConfig, bytes: number): Promise<void> {
  // Recheck the mount before every write, including after an unplug/replug.
  if (await realpath(config.mount) !== config.mount || await realpath(config.workspace) !== config.workspace
    || (await stat(config.mount)).dev === (await stat(path.dirname(config.mount))).dev
    || (await stat(config.workspace)).dev !== (await stat(config.mount)).dev) {
    throw new Error('Common Crawl scratch drive is no longer mounted.');
  }
  const space = await statfs(config.workspace);
  if (space.bavail * space.bsize < config.reserveBytes + bytes) throw new Error('Common Crawl paused to preserve free space on the scratch drive.');
}

export function localCrawlDirectoryUrl(indexId: string): string {
  if (!/^CC-MAIN-(?:\d{4}-\d{2}|2012|2008-2009|2009-2010)-index$/.test(indexId)) throw new Error(`Unsupported crawl identity: ${indexId}`);
  return `${DATA_ORIGIN}/cc-index/collections/${indexId.slice(0, -6)}/indexes/cluster.idx`;
}

export function localCrawlDirectoryFile(workspace: string, indexId: string): string {
  localCrawlDirectoryUrl(indexId);
  return path.join(workspace, `${indexId}.cluster.idx`);
}

function patternBounds(pattern: string): { low: string; high: string } {
  const match = /^(\*\.)?([a-z0-9.-]+)(\/.*)$/.exec(pattern);
  if (!match || !match[2].includes('.') || match[2].includes('..')) throw new Error(`Unsupported local URL pattern: ${pattern}`);
  // SURT removes www (including www1, etc.). Search a conservative host prefix
  // and apply the exact original host/path pattern only after decompression.
  const host = match[2].replace(/^www\d*\./, '');
  const low = host.split('.').reverse().join(',');
  return { low, high: low.slice(0, -1) + String.fromCharCode(low.charCodeAt(low.length - 1) + 1) };
}

export function localCrawlPatternMatches(pattern: string, value: string): boolean {
  const slash = pattern.indexOf('/');
  if (slash < 0) throw new Error('URL pattern must include a path.');
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol)) return false;
  const glob = (text: string) => new RegExp(`^${text.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return glob(pattern.slice(0, slash)).test(url.hostname.toLowerCase())
    && glob(pattern.slice(slash)).test(url.pathname + url.search);
}

export function localCrawlPlanHash(plan: LocalCrawlPlan): string {
  // PostgreSQL JSONB may reorder object keys when a saved plan is read back.
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
    return JSON.stringify(value);
  };
  return createHash('sha256').update(canonical(plan)).digest('hex');
}

/** Sparse rows describe intervals: always include the predecessor at a boundary. */
export async function planLocalCrawl(filename: string, indexId: string, patterns: LocalCrawlPattern[]): Promise<LocalCrawlPlan> {
  localCrawlDirectoryUrl(indexId);
  if (!patterns.length || new Set(patterns.map(p => JSON.stringify(p))).size !== patterns.length) throw new Error('A local crawl needs distinct URL patterns.');
  const bounds = patterns.map(p => patternBounds(p.pattern));
  const hash = createHash('sha256');
  const stream = createReadStream(filename);
  let directoryBytes = 0;
  stream.on('data', chunk => { hash.update(chunk); directoryBytes += chunk.length; });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const blocks: LocalCrawlBlock[] = [];
  let previous: Omit<LocalCrawlBlock, 'endKey' | 'patterns'> | null = null;
  const select = (row: NonNullable<typeof previous>, endKey: string | null) => {
    const matching = bounds.flatMap(({ low, high }, i) => row.key < high && (endKey === null || endKey > low) ? [i] : []);
    if (matching.length) blocks.push({ ...row, endKey, patterns: matching });
  };
  for await (const line of lines) {
    if (directoryBytes > MAX_DIRECTORY_BYTES) throw new Error('Common Crawl directory exceeded its size limit.');
    const fields = line.split('\t');
    const [key, shard, rawOffset, rawLength] = fields;
    const offset = Number(rawOffset); const length = Number(rawLength);
    if (fields.length < 4 || !key || !/^cdx-\d+\.gz$/.test(shard)
      || !/^\d+$/.test(rawOffset) || !/^\d+$/.test(rawLength)
      || !Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + length)
      || length <= 0 || length > MAX_BLOCK_BYTES) throw new Error('Malformed Common Crawl directory row.');
    if (previous) {
      if (key < previous.key || shard < previous.shard
        || (shard === previous.shard && offset !== previous.offset + previous.length)
        || (shard !== previous.shard && offset !== 0)) throw new Error('Common Crawl directory is out of order or has a block gap.');
      select(previous, key);
    } else if (offset !== 0) throw new Error('Common Crawl directory is missing its first block.');
    previous = { key, shard, offset, length };
  }
  if (!previous || !directoryBytes || !(await endsInNewline(filename))) throw new Error('Empty or truncated Common Crawl directory.');
  select(previous, null);
  return { version: 1, indexId, manifestSha256: hash.digest('hex'), directoryBytes, patterns,
    blocks, compressedBytes: blocks.reduce((n, block) => n + block.length, 0) };
}

async function endsInNewline(filename: string): Promise<boolean> {
  const file = await open(filename, 'r');
  try {
    const { size } = await file.stat(); const last = Buffer.alloc(1);
    if (!size) return false;
    await file.read(last, 0, 1, size - 1);
    return last[0] === 10;
  } finally { await file.close(); }
}

/** Atomic, bounded download. A 200 response to a range is never accepted. */
async function download(url: string, filename: string, maxBytes: number, range?: LocalCrawlBlock, fetcher = fetch): Promise<void> {
  const response = await fetcher(url, { headers: { ...HEADERS, ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}) }, signal: AbortSignal.timeout(120_000), redirect: 'error' });
  try {
    if (response.status !== (range ? 206 : 200) || !response.body) throw new Error(`Common Crawl file request returned HTTP ${response.status}.`);
    if (range) {
      const expected = `bytes ${range.offset}-${range.offset + range.length - 1}/`;
      const contentRange = response.headers.get('content-range');
      if (!contentRange?.startsWith(expected) || !/^\d+$/.test(contentRange.slice(expected.length))
        || Number(contentRange.slice(expected.length)) < range.offset + range.length) throw new Error('Common Crawl returned an incorrect byte range.');
    }
    const declared = response.headers.get('content-length');
    if (declared === null || !/^\d+$/.test(declared) || Number(declared) > maxBytes || Number(declared) <= 0
      || (range && Number(declared) !== range.length)) throw new Error('Common Crawl returned an invalid file length.');
    const file = await open(`${filename}.part`, 'w', 0o600);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        received += chunk.length;
        if (received > maxBytes) throw new Error('Common Crawl download exceeded its size limit.');
        await file.writeFile(chunk);
      }
      if (received !== Number(declared)) throw new Error('Common Crawl download was truncated.');
      await file.sync();
    } finally { await reader.cancel(); reader.releaseLock(); await file.close(); }
    await rename(`${filename}.part`, filename);
  } finally { if (!response.bodyUsed) await response.body?.cancel(); }
}

export async function downloadLocalCrawlDirectory(workspace: string, indexId: string, fetcher = fetch): Promise<string> {
  const filename = localCrawlDirectoryFile(workspace, indexId);
  // Re-fetch directories rather than trusting an orphaned or incomplete file.
  await download(localCrawlDirectoryUrl(indexId), filename, MAX_DIRECTORY_BYTES, undefined, fetcher);
  return filename;
}

export function localCrawlBlockFile(workspace: string, planHash: string, ordinal: number): string {
  if (!/^[a-f0-9]{64}$/.test(planHash) || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Invalid local block identity.');
  return path.join(workspace, `${planHash}-${ordinal}.cdx.gz`);
}

export async function readLocalCrawlBlock(plan: LocalCrawlPlan, ordinal: number, workspace: string, fetcher = fetch): Promise<Array<{ url: string }>> {
  const block = plan.blocks[ordinal];
  if (!block) throw new Error('Local crawl block is outside its plan.');
  const filename = localCrawlBlockFile(workspace, localCrawlPlanHash(plan), ordinal);
  let data: Buffer | null = null;
  try { data = await readFile(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (data?.length !== block.length) {
    await download(localCrawlDirectoryUrl(plan.indexId).replace('cluster.idx', block.shard), filename, block.length, block, fetcher);
    data = await readFile(filename);
  }
  try {
    const expanded = new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(data!, { maxOutputLength: MAX_EXPANDED_BYTES }));
    if (!expanded.endsWith('\n')) throw new Error('Truncated Common Crawl block.');
    const records: Array<{ url: string }> = [];
    let lastKey = '';
    for (const line of expanded.slice(0, -1).split('\n')) {
      const match = /^(\S+ \d{14}) (\{.*\})$/.exec(line);
      if (!match) throw new Error(`Common Crawl block ${ordinal} has a malformed CDXJ line: ${line.slice(0, 160)}`);
      if ((lastKey && match[1] < lastKey) || match[1] < block.key
        || (block.endKey !== null && match[1] > block.endKey)) throw new Error(`Common Crawl block ${ordinal} does not match its directory boundaries: ${JSON.stringify({ key: match[1], previous: lastKey, start: block.key, end: block.endKey })}`);
      if (!lastKey && match[1] !== block.key) throw new Error('Common Crawl block starts at the wrong record.');
      const record = JSON.parse(match[2]);
      if (typeof record.url !== 'string' || !record.url) throw new Error('Common Crawl block contains a malformed record.');
      records.push({ url: record.url }); lastKey = match[1];
    }
    if (!records.length) throw new Error('Common Crawl returned an empty compressed block.');
    return records;
  } catch (error) {
    // Discard only this unaccepted corrupt cache entry, so retry can re-fetch it.
    await unlink(filename);
    throw error;
  }
}

export async function removeLocalCrawlFile(filename: string): Promise<void> {
  try { await unlink(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
