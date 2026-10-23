import type { IndexerBoardStats } from '@/lib/statsIndexerBoards';

export function IndexerBoardsCard({ stats }: { stats?: IndexerBoardStats }) {
  const number = (value: number | null | undefined) => stats?.available && value != null ? value.toLocaleString('en-US') : '—';
  return (
    <article className="ops-metric-card ops-indexer-card" aria-label="New boards found by indexer">
      <span>New boards found · Indexer</span>
      <div className="ops-indexer-values">
        <div><span>Last 24 hours</span><strong>{number(stats?.last24Hours)}</strong></div>
        <div><span>All time</span><strong>{number(stats?.allTime)}</strong></div>
      </div>
      <small>{stats?.available ? 'New to your Dashboard · repeat finds excluded' : 'Indexer discovery counts temporarily unavailable'}</small>
    </article>
  );
}
