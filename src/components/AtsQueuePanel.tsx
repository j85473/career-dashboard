'use client';

import { useEffect, useState } from 'react';
import { startClientPolling } from '@/lib/clientPolling';
import { atsRetryLabel, type AtsQueueSnapshot } from '@/lib/atsQueueSnapshot';

const count = (value: number) => value.toLocaleString('en-US');

export function AtsQueuePanel({ snapshot, unavailable = false }: {
  snapshot?: AtsQueueSnapshot | null; unavailable?: boolean;
}) {
  const [stage, setStage] = useState('All stages');
  const visibleHolds = snapshot?.holds.filter(hold => stage === 'All stages' || hold.stage === stage) || [];
  if (!snapshot) return <section className="ats-queue-panel" aria-label="ATS queues"><p role="status">{unavailable ? 'ATS queue details are temporarily unavailable. Refreshing automatically.' : 'Loading ATS queue details…'}</p></section>;
  const retryHolds = snapshot.holds.filter(hold => hold.retryAt);
  const earliest = retryHolds.map(hold => hold.retryAt!).sort()[0] || null;
  return (
    <details className="ats-queue-panel" aria-label="ATS queues" open>
      <summary className="ats-queue-heading">
        <strong>New boards &amp; held work</strong>
      </summary>
      <dl className="ats-queue-metrics">
        <div><dt>Ready for validation</dt><dd>{count(snapshot.validationDue)}</dd></div>
        <div><dt>Validation retry holds</dt><dd>{count(snapshot.validationHeld)}</dd></div>
        <div><dt>Size review required</dt><dd>{count(snapshot.sizeReview)}</dd></div>
        <div><dt>First-collection queue</dt><dd>{count(snapshot.ready)}</dd></div>
        <div><dt>Awaiting handoff</dt><dd>{count(snapshot.awaitingHandoff)}</dd></div>
        <div><dt>Unfinished collections</dt><dd>{count(snapshot.collecting)}</dd></div>
      </dl>
      <details className="ats-queue-holds">
        <summary>
          <span>Hold &amp; retry details · {count(snapshot.holds.length)} groups</span>
          <span className="ats-queue-next-retry">{earliest ? <>Retry eligibility: {atsRetryLabel(earliest, snapshot.observedAt)}</> : 'No timed retry holds'}</span>
        </summary>
        <p className="ats-queue-help">{snapshot.admissionNote}</p>
        <div className="ats-queue-persistence">
          <span>Normalization &amp; persistence: <strong>{count(snapshot.persistenceDue)} runnable items</strong> · <strong>{count(snapshot.persistenceHeld)} held items</strong></span>
        </div>
        <p className="ats-queue-help">Each row counts its own stage; do not add these counts together. Validation due retains failed candidates after their retry time passes. Times are Central and show earliest eligibility, not a promised attempt. Validation also waits for intake capacity and admission policy. Acquisition handoff is checked every five minutes.</p>
        <label className="ats-queue-filter">Show stage
          <select value={stage} onChange={event => setStage(event.target.value)}>
            {['All stages', 'First collection', 'Validation due', 'Validation', 'Size review', 'Persistence', 'Acquisition', 'Provider', 'Common Crawl'].map(value => <option key={value}>{value}</option>)}
          </select>
        </label>
        {visibleHolds.length === 0 ? <p>No held work in this view.</p> : (
          <div className="ats-queue-table-scroll">
            <table className="ats-queue-table">
              <thead><tr><th>Stage / provider</th><th>Work awaiting retry</th><th>Reason</th><th>Earliest eligibility</th></tr></thead>
              <tbody>{visibleHolds.map((hold, index) => (
                <tr key={`${hold.stage}:${hold.provider}:${index}`}>
                  <td><strong>{hold.stage}</strong><br />{hold.provider}</td>
                  <td>{count(hold.count)} {hold.unit}{hold.items > 0 && <><br /><span>{count(hold.items)} remaining items</span></>}</td>
                  <td>{hold.reason}{hold.example && <details className="ats-queue-example"><summary>Example board or source</summary><span>{hold.example}</span></details>}</td>
                  <td>{hold.stage === 'First collection' && !hold.retryAt && hold.reason.startsWith('Awaiting automatic')
                    ? 'Next handoff check · within five minutes'
                    : atsRetryLabel(hold.retryAt, snapshot.observedAt, hold.stage === 'Size review' || /review required/i.test(hold.reason))}
                    {hold.lastRetryAt && hold.lastRetryAt !== hold.retryAt && <small>Other retries through {atsRetryLabel(hold.lastRetryAt, snapshot.observedAt)}</small>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="ats-queue-observed">Observed {new Date(snapshot.observedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })} Central</p>
      </details>
      {unavailable && <p className="ats-queue-observed" role="status">Refresh unavailable · showing last observed counts</p>}
    </details>
  );
}

/** Queue diagnostics poll independently so heavy reads cannot delay pipeline
 * controls, the health endpoint or the existing three-second status refresh. */
export function LiveAtsQueuePanel() {
  const [snapshot, setSnapshot] = useState<AtsQueueSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const polling = startClientPolling({
      request: async signal => {
        const response = await fetch('/api/pipeline/ats-queues', { signal });
        if (!response.ok) throw new Error('Queue diagnostics unavailable');
        return await response.json() as AtsQueueSnapshot;
      },
      onData: data => { setSnapshot(data); setUnavailable(false); },
      onError: () => setUnavailable(true),
      intervalMs: () => document.hidden ? 60000 : 15000,
    });
    return () => polling.stop();
  }, []);
  return <AtsQueuePanel snapshot={snapshot} unavailable={unavailable} />;
}
