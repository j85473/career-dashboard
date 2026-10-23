import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type IndexerBoardStats = { available: boolean; last24Hours: number | null; allTime: number | null };

/** Read the indexer's unique identities without starting it or changing its saved work. */
export function readIndexerBoardStats(
  now = Date.now(),
  filename = process.env.ATS_WEB_DISCOVERY_STATE || path.join(process.cwd(), 'data/runtime/ats-web-discovery/state.sqlite'),
): IndexerBoardStats {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA busy_timeout=50; PRAGMA query_only=ON');
    const row = db.prepare(`SELECT COUNT(*) AS total,
      COUNT(CASE WHEN first_seen >= ? THEN 1 END) AS recent
      FROM boards WHERE status = 'registered' AND first_seen <= ?`).get(now - 86_400_000, now)!;
    return { available: true, last24Hours: Number(row.recent), allTime: Number(row.total) };
  } catch {
    // Missing or temporarily busy discovery state is not evidence of zero finds.
    return { available: false, last24Hours: null, allTime: null };
  } finally { db?.close(); }
}
