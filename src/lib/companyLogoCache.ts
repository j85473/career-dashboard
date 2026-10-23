import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { LogoSubject } from './companyLogo';
import { companyLogoScope, companyLogoSources } from './companyLogoSources';
import { employerLabelKey } from './employerIdentity';
import { safeExternalFetch } from './safeExternalFetch';

const DAY = 86_400_000;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_SAVED_BYTES = 128 * 1024;
const MAX_MEMORY_ENTRIES = 256;

export type CompanyLogoAsset = {
  version: 1;
  key: string;
  sourceUrl: string;
  verifiedAt: number;
  png: Buffer;
};

export type CompanyLogoStore = {
  read(key: string): Promise<CompanyLogoAsset | null>;
  write(asset: CompanyLogoAsset): Promise<void>;
};

/** A tenant change or explicit corporate-site correction gets its own branding. */
export function companyLogoCacheKey(subject: LogoSubject): string {
  return createHash('sha256').update(JSON.stringify([
    employerLabelKey(subject.company), companyLogoScope(subject),
  ])).digest('hex');
}

/** This directory is already shared between M70 releases and included in backups. */
export function createCompanyLogoStore(directory = path.join(process.cwd(), 'data/runtime/company-logos')): CompanyLogoStore {
  const filename = (key: string) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid logo cache key');
    return path.join(directory, `${key}.json`);
  };
  return {
    async read(key) {
      try {
        const target = filename(key);
        if ((await stat(target)).size > MAX_SAVED_BYTES * 2) return null;
        const data = JSON.parse(await readFile(target, 'utf8'));
        if (data.version !== 1 || data.key !== key || typeof data.sourceUrl !== 'string'
          || !Number.isFinite(data.verifiedAt) || typeof data.png !== 'string') return null;
        const png = Buffer.from(data.png, 'base64');
        if (png.length > MAX_SAVED_BYTES || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
        // A truncated file may retain a valid PNG header. Decode its pixels
        // once when loading from disk so the next request can repair it.
        await sharp(png, { limitInputPixels: 128 * 128, failOn: 'warning' }).stats();
        return { version: 1, key, sourceUrl: data.sourceUrl, verifiedAt: data.verifiedAt, png };
      } catch { return null; }
    },
    async write(asset) {
      const target = filename(asset.key);
      await mkdir(directory, { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ ...asset, png: asset.png.toString('base64') }), { flag: 'wx' });
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    },
  };
}

/** Decode the image itself: HTML, empty files and misleading MIME types cannot win. */
export async function companyLogoPng(response: Response): Promise<Buffer | null> {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) return null;
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || meta.width < 8 || meta.height < 8) return null;
    const png = await image.resize(128, 128, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const stats = await sharp(png).stats();
    if (stats.channels.length === 4 && stats.channels[3].max === 0) return null;
    if (stats.channels.slice(0, 3).every(channel => channel.min === 255)) return null;
    return png.length <= MAX_SAVED_BYTES ? png : null;
  } catch { return null; }
}

export class CompanyLogoBusyError extends Error {}

/** Successful image bytes persist; misses are short-lived and specific to a posting. */
export function createCompanyLogoCache(options: {
  store: CompanyLogoStore;
  sources?: (subject: LogoSubject) => AsyncIterable<string>;
  fetchImage?: (url: string) => Promise<Response>;
  now?: () => number;
  concurrency?: number;
}) {
  const now = options.now || Date.now;
  const memory = new Map<string, CompanyLogoAsset>();
  const misses = new Map<string, number>();
  const pending = new Map<string, Promise<CompanyLogoAsset | null>>();
  const sharedPending = new Map<string, Promise<CompanyLogoAsset | null>>();
  const failedRefreshes = new Map<string, number>();
  const waiting: Array<() => void> = [];
  let active = 0;
  const remember = (asset: CompanyLogoAsset) => {
    if (memory.size >= MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
    memory.set(asset.key, asset);
  };
  const read = async (key: string) => {
    const found = memory.get(key) || await options.store.read(key).catch(() => null);
    if (found) remember(found);
    return found;
  };
  const recover = (subject: LogoSubject, key: string) => {
    // Successes share a scope, but an expired posting must not suppress another
    // job's independent evidence while its lookup is still running.
    const attemptKey = JSON.stringify([key, subject.canonicalUrl, subject.url]);
    if (pending.has(attemptKey)) return pending.get(attemptKey)!;
    if ((misses.get(attemptKey) || 0) > now()) return Promise.resolve(null);
    if (pending.size >= 100) return Promise.reject(new CompanyLogoBusyError('Logo recovery is busy'));
    const task = (async () => {
      if (active >= (options.concurrency || 6)) await new Promise<void>(resolve => waiting.push(resolve));
      else active++;
      try {
        // A different posting may have resolved this employer while we waited.
        const shared = memory.get(key);
        if (shared && now() - shared.verifiedAt < 30 * DAY) return shared;
        const deadline = AbortSignal.timeout(20_000);
        const fetchExternal = (url: string, accept: string) => safeExternalFetch(url, {
          signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
          headers: { Accept: accept, 'User-Agent': 'CareerDashboard/1.0' },
        }, 5, { maximumBytes: accept === 'text/html' ? 2 * MAX_IMAGE_BYTES : MAX_IMAGE_BYTES });
        const sources = options.sources?.(subject) || companyLogoSources(subject, url => fetchExternal(url, 'text/html'));
        const tried = new Set<string>();
        for await (const url of sources) {
          if (tried.has(url)) continue;
          tried.add(url);
          if (tried.size > 12 || deadline.aborted) break;
          try {
            const png = await companyLogoPng(await (options.fetchImage?.(url) || fetchExternal(url, 'image/*')));
            if (!png) continue;
            const asset: CompanyLogoAsset = { version: 1, key, sourceUrl: url, verifiedAt: now(), png };
            // Update memory even if the disk is temporarily unavailable.
            await options.store.write(asset).catch(() => {});
            remember(asset);
            failedRefreshes.delete(key);
            return asset;
          } catch { /* A broken image does not end the candidate chain. */ }
        }
        if (misses.size >= 1000) misses.delete(misses.keys().next().value!);
        misses.set(attemptKey, now() + 60_000);
        return null;
      } finally {
        const next = waiting.shift();
        if (next) next(); else active--;
      }
    })();
    pending.set(attemptKey, task);
    return task.finally(() => { pending.delete(attemptKey); });
  };
  return {
    async get(subject: LogoSubject): Promise<CompanyLogoAsset | null> {
      const key = companyLogoCacheKey(subject);
      const saved = await read(key);
      if (saved) return saved;
      const existing = sharedPending.get(key);
      if (existing) {
        const shared = await existing;
        if (shared) return shared;
      }
      const task = recover(subject, key);
      sharedPending.set(key, task);
      try { return await task; }
      finally { if (sharedPending.get(key) === task) sharedPending.delete(key); }
    },
    needsRefresh(asset: CompanyLogoAsset) {
      return now() - asset.verifiedAt >= 30 * DAY && (failedRefreshes.get(asset.key) || 0) <= now();
    },
    async refresh(subject: LogoSubject): Promise<void> {
      const key = companyLogoCacheKey(subject);
      if ((failedRefreshes.get(key) || 0) > now()) return;
      if (!await recover(subject, key)) {
        if (failedRefreshes.size >= 1000) failedRefreshes.delete(failedRefreshes.keys().next().value!);
        failedRefreshes.set(key, now() + DAY);
      }
      // Never remove a working saved image when a source is unavailable.
    },
  };
}

export const companyLogoCache = createCompanyLogoCache({ store: createCompanyLogoStore() });
