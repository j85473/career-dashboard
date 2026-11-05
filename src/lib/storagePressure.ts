import { readFileSync, statfsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';

export type StoragePressure = {
  version: 1;
  checkedAt: string;
  level: 'disabled' | 'normal' | 'warning' | 'collection_paused' | 'critical' | 'unknown';
  freeBytes: number | null;
  totalBytes: number | null;
  collectionPaused: boolean;
  backgroundPaused: boolean;
  message: string;
  growthBytesPerDay?: number | null;
  daysToCollectionPause?: number | null;
};

const GIB = 1024 ** 3;
export const STORAGE_LIMITS = { warning: 40 * GIB, collection: 30 * GIB, critical: 15 * GIB, resume: 40 * GIB };

/** A second, independent read catches a sudden drop between monitor ticks.
 * Missing/stale telemetry fails closed only for unattended work, never cards. */
export function evaluateStoragePressure(snapshot: StoragePressure | null, freeBytes: number | null,
  totalBytes: number | null, now = Date.now()): StoragePressure {
  const unknown = !snapshot || snapshot.version !== 1 || snapshot.level === 'unknown' || !Number.isFinite(Date.parse(snapshot.checkedAt))
    || typeof snapshot.collectionPaused !== 'boolean' || typeof snapshot.backgroundPaused !== 'boolean'
    || now - Date.parse(snapshot.checkedAt) > 90_000 || Date.parse(snapshot.checkedAt) > now + 5_000
    || !Number.isFinite(freeBytes) || freeBytes === null || freeBytes < 0 || totalBytes === null || totalBytes <= 0;
  if (unknown) return { version: 1, checkedAt: new Date(now).toISOString(), level: 'unknown', freeBytes, totalBytes,
    collectionPaused: true, backgroundPaused: true,
    message: 'Background work is paused because database disk capacity cannot be verified. Your saved jobs remain available.' };
  const critical = freeBytes < STORAGE_LIMITS.critical || snapshot.backgroundPaused;
  const paused = critical || freeBytes < STORAGE_LIMITS.collection || snapshot.collectionPaused;
  const level = critical ? 'critical' : paused ? 'collection_paused' : freeBytes < STORAGE_LIMITS.warning ? 'warning' : 'normal';
  return { ...snapshot, level, freeBytes, totalBytes, collectionPaused: paused, backgroundPaused: critical,
    message: critical ? 'Background work is paused to preserve database space. Your saved jobs remain available.'
      : paused ? 'New collection is paused to preserve database space. Saved work can finish; your jobs remain available.'
        : level === 'warning' ? 'Database disk space is low. Collection will pause before the reserve is exhausted.' : '' };
}

let cached: { at: number; value: StoragePressure } | null = null;
export function readStoragePressure(): StoragePressure {
  // Production is on M70. Development/build/test hosts must not inspect a
  // similarly named local disk or make production network calls.
  if (hostname() !== 'm70' && !process.env.CAREER_STORAGE_STATUS_FILE) return {
    version: 1, checkedAt: new Date().toISOString(), level: 'disabled', freeBytes: null, totalBytes: null,
    collectionPaused: false, backgroundPaused: false, message: '',
  };
  const now = Date.now();
  if (cached && now - cached.at < 1_000) return cached.value;
  let value: StoragePressure;
  try {
    const snapshot = JSON.parse(readFileSync(process.env.CAREER_STORAGE_STATUS_FILE
      || '/var/lib/career-dashboard/data/runtime/storage-pressure.json', 'utf8')) as StoragePressure;
    const diskPath = process.env.CAREER_STORAGE_TEST_PATH || '/mnt/nvme';
    if (!process.env.CAREER_STORAGE_TEST_PATH && statSync(diskPath).dev === statSync('/').dev) throw new Error('Database mount is missing');
    const disk = statfsSync(diskPath);
    value = evaluateStoragePressure(snapshot, disk.bavail * disk.bsize, disk.blocks * disk.bsize, now);
  } catch {
    value = evaluateStoragePressure(null, null, null, now);
  }
  cached = { at: now, value };
  return value;
}

export function storageAllows(work: 'collection' | 'background'): boolean {
  const state = readStoragePressure();
  return work === 'collection' ? !state.collectionPaused : !state.backgroundPaused;
}
