import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DASHBOARD_SLOW_REQUEST_MS = 1500;
export const DISCOVERY_PRESSURE_BACKOFF_MS = 60_000;

export type DashboardResponsiveness = {
  version: 1;
  pid: number;
  updatedAt: number;
  activeRequests: number;
  oldestActiveAt: number | null;
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  cooldownUntil: number;
};

/** Passive timing only: no extra Dashboard requests, queries, or job contents. */
export function createDashboardResponsivenessRecorder(options: {
  now?: () => number;
  pid?: number;
  publish: (snapshot: DashboardResponsiveness) => Promise<void>;
  onError?: () => void;
}) {
  const now = options.now ?? Date.now;
  const active = new Map<number, number>();
  let sequence = 0;
  let completedAt: number | null = null;
  let durationMs: number | null = null;
  let cooldownUntil = 0;
  let dirty = false;
  let writing: Promise<void> | undefined;
  const snapshot = (): DashboardResponsiveness => ({
    version: 1, pid: options.pid ?? process.pid, updatedAt: now(), activeRequests: active.size,
    oldestActiveAt: active.size ? Math.min(...active.values()) : null,
    lastCompletedAt: completedAt, lastDurationMs: durationMs, cooldownUntil,
  });
  const publish = () => {
    dirty = true;
    if (writing) return;
    // Coalesce overlapping events; a slow disk never becomes a request await.
    writing = (async () => {
      while (dirty) {
        dirty = false;
        try { await options.publish(snapshot()); } catch { options.onError?.(); }
      }
    })().finally(() => {
      writing = undefined;
      if (dirty) publish();
    });
  };
  return {
    snapshot,
    initialize: publish,
    flush: async () => { while (writing) await writing; },
    async track<T extends { status: number }>(handler: () => Promise<T>): Promise<T> {
      const id = ++sequence;
      const startedAt = now();
      active.set(id, startedAt);
      publish();
      let failed = true;
      try {
        const response = await handler();
        failed = response.status >= 500;
        return response;
      } finally {
        completedAt = now();
        durationMs = Math.max(0, completedAt - startedAt);
        active.delete(id);
        if (failed || durationMs >= DASHBOARD_SLOW_REQUEST_MS) {
          cooldownUntil = completedAt + DISCOVERY_PRESSURE_BACKOFF_MS;
        }
        publish();
      }
    },
  };
}

type Recorder = ReturnType<typeof createDashboardResponsivenessRecorder>;
const shared = globalThis as typeof globalThis & { dashboardResponsivenessRecorder?: { filename: string; recorder: Recorder } };

function dashboardRecorder(): Recorder | undefined {
  const filename = process.env.DASHBOARD_RESPONSIVENESS_FILE;
  if (!filename) return undefined;
  if (shared.dashboardResponsivenessRecorder?.filename !== filename) {
    let directoryReady = false;
    let lastWarningAt = 0;
    const recorder = createDashboardResponsivenessRecorder({
      publish: async snapshot => {
        if (!directoryReady) {
          await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
          directoryReady = true;
        }
        const temporary = `${filename}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        await rename(temporary, filename);
      },
      onError: () => {
        if (Date.now() - lastWarningAt >= DISCOVERY_PRESSURE_BACKOFF_MS) {
          lastWarningAt = Date.now();
          console.warn('Unable to save Dashboard responsiveness telemetry for discovery');
        }
      },
    });
    shared.dashboardResponsivenessRecorder = { filename, recorder };
  }
  return shared.dashboardResponsivenessRecorder.recorder;
}

/** Initialize idle telemetry at web startup, including unattended reboots. */
export function initializeDashboardResponsiveness(): void {
  dashboardRecorder()?.initialize();
}

export function observeDashboardJobList<T extends { status: number }>(handler: () => Promise<T>): Promise<T> {
  const recorder = dashboardRecorder();
  return recorder ? recorder.track(handler) : handler();
}

export function dashboardResponsivenessPressure(value: unknown, now: number, isAlive: (pid: number) => boolean): string | null {
  if (!value || typeof value !== 'object') return 'paused_for_dashboard_telemetry';
  const sample = value as DashboardResponsiveness;
  const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
  if (sample.version !== 1 || !integer(sample.pid) || sample.pid === 0 || !integer(sample.updatedAt)
    || sample.updatedAt > now + 5000 || !integer(sample.activeRequests) || !integer(sample.cooldownUntil)
    || !(sample.lastCompletedAt === null || integer(sample.lastCompletedAt))
    || !(sample.lastDurationMs === null || integer(sample.lastDurationMs))
    || (sample.activeRequests === 0 ? sample.oldestActiveAt !== null : !integer(sample.oldestActiveAt))
    || (sample.oldestActiveAt !== null && sample.oldestActiveAt > sample.updatedAt)
    || !isAlive(sample.pid)) return 'paused_for_dashboard_telemetry';
  if (sample.cooldownUntil > now
    || (sample.oldestActiveAt !== null && now - sample.oldestActiveAt >= DASHBOARD_SLOW_REQUEST_MS)) {
    return 'paused_for_dashboard_response';
  }
  // Old, idle samples remain useful: no user traffic needs no polling load.
  return null;
}

export function createDashboardPressureCheck(filename: string | undefined, options: {
  now?: () => number; read?: () => string; isAlive?: (pid: number) => boolean;
} = {}): () => string | null {
  if (!filename) return () => null;
  const now = options.now ?? Date.now;
  const read = options.read ?? (() => readFileSync(filename, 'utf8'));
  const isAlive = options.isAlive ?? (pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  let checkedAt = -Infinity;
  let result: string | null = null;
  return () => {
    const at = now();
    if (at - checkedAt < 1000) return result;
    checkedAt = at;
    try {
      const raw = read();
      result = raw.length > 4096 ? 'paused_for_dashboard_telemetry'
        : dashboardResponsivenessPressure(JSON.parse(raw), at, isAlive);
    } catch { result = 'paused_for_dashboard_telemetry'; }
    return result;
  };
}
