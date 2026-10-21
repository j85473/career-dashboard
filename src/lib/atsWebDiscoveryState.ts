import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { WebDiscoveredBoard } from './atsWebDiscoveryLinks';

export type DiscoveryPage = {
  url: string; origin: string; depth: number; priority: number; attempts: number; redirect_hops: number;
};
export type DiscoveryHost = {
  origin: string; next_at: number; cooldown_until: number; window_at: number; requests: number;
  robots_body: string; robots_kind: string; robots_until: number; robots_delay: number;
};
export type DiscoveryCandidate = WebDiscoveredBoard & {
  sourceUrl: string; attempts: number;
};

/** Dedicated crawler state: no Dashboard schema, scores, jobs, or Common Crawl receipts. */
export class AtsWebDiscoveryState {
  private readonly db: DatabaseSync;
  readonly owner = randomUUID();

  constructor(path: string, readOnly = false) {
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec('PRAGMA busy_timeout=5000');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error('Unsupported ATS web discovery state version; saved work was not changed');
    }
    if (readOnly) return;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA max_page_count=131072;
      PRAGMA wal_autocheckpoint=256;
      PRAGMA journal_size_limit=16777216;
      CREATE TABLE IF NOT EXISTS frontier (
        url TEXT PRIMARY KEY, origin TEXT NOT NULL, depth INTEGER NOT NULL, priority INTEGER NOT NULL,
        source_url TEXT NOT NULL, first_seen INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        next_at INTEGER DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        redirect_hops INTEGER NOT NULL DEFAULT 0, last_status INTEGER, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS frontier_ready ON frontier(next_at, priority);
      CREATE TABLE IF NOT EXISTS hosts (
        origin TEXT PRIMARY KEY, next_at INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0,
        window_at INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
        robots_body TEXT NOT NULL DEFAULT '', robots_kind TEXT NOT NULL DEFAULT 'retry',
        robots_until INTEGER NOT NULL DEFAULT 0, robots_delay INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS boards (
        platform TEXT NOT NULL, slug TEXT NOT NULL, matched_url TEXT NOT NULL, source_url TEXT NOT NULL,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        PRIMARY KEY(platform,slug)
      );
      CREATE INDEX IF NOT EXISTS boards_ready ON boards(status,next_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO lease VALUES(1,NULL,0);
      PRAGMA user_version=1;
    `);
  }

  close(): void { this.db.close(); }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  acquire(now: number): void {
    const result = this.db.prepare(`UPDATE lease SET owner=?, expires_at=? WHERE id=1 AND (owner IS NULL OR expires_at<=?)`)
      .run(this.owner, now + 120_000, now);
    if (!result.changes) throw new Error('Another ATS web discovery worker owns this state file');
  }

  renew(now: number): void {
    const result = this.db.prepare('UPDATE lease SET expires_at=? WHERE id=1 AND owner=?').run(now + 120_000, this.owner);
    if (!result.changes) throw new Error('ATS web discovery lease was lost');
  }

  release(): void {
    this.db.prepare('UPDATE lease SET owner=NULL,expires_at=0 WHERE id=1 AND owner=?').run(this.owner);
  }

  metric(name: string): number {
    return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(name)?.value || 0);
  }

  setMetric(name: string, value: number): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, value);
  }

  increment(name: string, by = 1): void { this.setMetric(name, this.metric(name) + by); }

  enqueue(url: string, source: string, depth: number, priority: number, now: number, maximumUrls: number, redirectHops = 0): boolean {
    const existing = this.db.prepare('SELECT url FROM frontier WHERE url=?').get(url);
    if (existing) {
      this.db.prepare('UPDATE frontier SET depth=MIN(depth,?),priority=MAX(priority,?) WHERE url=?').run(depth, priority, url);
      return true;
    }
    const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM frontier').get()!.count);
    if (count >= maximumUrls) { this.increment('linksOmittedAtCapacity'); return false; }
    const origin = new URL(url).origin;
    this.db.prepare('INSERT OR IGNORE INTO hosts(origin) VALUES(?)').run(origin);
    this.db.prepare(`INSERT INTO frontier(url,origin,depth,priority,source_url,first_seen,redirect_hops) VALUES(?,?,?,?,?,?,?)`)
      .run(url, origin, depth, priority, source, now, redirectHops);
    return true;
  }

  recordBoard(board: WebDiscoveredBoard, source: string, now: number): void {
    this.db.prepare(`INSERT INTO boards(platform,slug,matched_url,source_url,first_seen,last_seen)
      VALUES(?,?,?,?,?,?) ON CONFLICT(platform,slug) DO UPDATE SET last_seen=excluded.last_seen`)
      .run(board.platform, board.slug, board.matchedUrl, source, now, now);
  }

  host(origin: string): DiscoveryHost {
    this.db.prepare('INSERT OR IGNORE INTO hosts(origin) VALUES(?)').run(origin);
    return this.db.prepare('SELECT * FROM hosts WHERE origin=?').get(origin) as unknown as DiscoveryHost;
  }

  saveRobots(origin: string, body: string, kind: string, until: number, delay: number): void {
    this.db.prepare('UPDATE hosts SET robots_body=?,robots_kind=?,robots_until=?,robots_delay=? WHERE origin=?')
      .run(body, kind, until, delay, origin);
  }

  reserveRequest(origin: string, now: number, interval: number, globalInterval: number): void {
    this.host(origin);
    this.db.prepare(`UPDATE hosts SET next_at=?,requests=CASE WHEN window_at<=? THEN 1 ELSE requests+1 END,
      window_at=CASE WHEN window_at<=? THEN ? ELSE window_at END WHERE origin=?`)
      .run(now + interval, now - 86_400_000, now - 86_400_000, now, origin);
    this.setMetric('nextGlobalRequestAt', now + globalInterval);
    this.increment('requests');
  }

  cooldown(origin: string, until: number): void {
    this.db.prepare('UPDATE hosts SET cooldown_until=MAX(cooldown_until,?) WHERE origin=?').run(until, origin);
  }

  nextPage(now: number, requestsPerHost: number, explore: boolean): DiscoveryPage | null {
    return this.db.prepare(`SELECT f.* FROM frontier f JOIN hosts h ON h.origin=f.origin
      WHERE f.next_at IS NOT NULL AND f.next_at<=? AND h.next_at<=? AND h.cooldown_until<=?
        AND (h.window_at<=? OR h.requests<?)
      ORDER BY ${explore ? 'CASE WHEN h.window_at<=? THEN 0 ELSE h.requests END ASC,' : ''}
        ${explore ? '' : 'f.priority DESC,'} f.first_seen ASC, f.url ASC LIMIT 1`)
      .get(now, now, now, now - 86_400_000, requestsPerHost, ...(explore ? [now - 86_400_000] : [])) as unknown as DiscoveryPage || null;
  }

  nextDue(requestsPerHost: number, now: number): number | null {
    const row = this.db.prepare(`SELECT MIN(MAX(f.next_at,h.next_at,h.cooldown_until,
      CASE WHEN h.requests>=? AND h.window_at>? THEN h.window_at+86400000 ELSE 0 END)) AS due
      FROM frontier f JOIN hosts h ON h.origin=f.origin WHERE f.next_at IS NOT NULL`)
      .get(requestsPerHost, now - 86_400_000);
    return row?.due == null ? null : Number(row.due);
  }

  finishPage(url: string, status: string, nextAt: number | null, httpStatus: number | null, error: string | null = null): void {
    this.db.prepare(`UPDATE frontier SET status=?,next_at=?,last_status=?,last_error=?,
      attempts=CASE WHEN ?='retry' THEN attempts+1 WHEN ?='visited' THEN 0 ELSE attempts END WHERE url=?`)
      .run(status, nextAt, httpStatus, error, status, status, url);
  }

  pendingCandidates(limit: number, now: number): DiscoveryCandidate[] {
    return this.db.prepare(`SELECT platform,slug,matched_url AS matchedUrl,source_url AS sourceUrl,attempts
      FROM boards WHERE status IN ('pending','retry') AND next_at<=? ORDER BY first_seen,platform,slug LIMIT ?`)
      .all(now, limit).map(row => ({ ...row })) as unknown as DiscoveryCandidate[];
  }

  finishCandidate(board: WebDiscoveredBoard, status: string, now: number, error: string | null = null): void {
    this.db.prepare(`UPDATE boards SET status=?,next_at=?,last_error=?,attempts=attempts+1 WHERE platform=? AND slug=?`)
      .run(status, now + 60 * 60_000, error, board.platform, board.slug);
  }

  report() {
    const grouped = (table: 'frontier' | 'boards') => this.db.prepare(`SELECT status,COUNT(*) AS count FROM ${table} GROUP BY status`).all().map(row => ({ ...row }));
    return {
      pages: grouped('frontier'), boards: grouped('boards'),
      hosts: Number(this.db.prepare('SELECT COUNT(*) AS count FROM hosts').get()!.count),
      requests: this.metric('requests'), bytesRead: this.metric('bytesRead'), pagesVisited: this.metric('pagesVisited'),
      linksOmittedAtCapacity: this.metric('linksOmittedAtCapacity'),
    };
  }
}
