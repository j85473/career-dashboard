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
    <section className="ats-queue-panel" aria-label="ATS queues">
      <div className="ats-queue-heading">
        <strong>New boards &amp; held work</strong>
        <span>{snapshot.admissionNote}</span>
      </div>
      <dl className="ats-queue-metrics">
        <div><dt>Ready for validation</dt><dd>{count(snapshot.validationDue)}</dd></div>
        <div><dt>Validation retry holds</dt><dd>{count(snapshot.validationHeld)}</dd></div>
        <div><dt>Validated first-collection queue</dt><dd>{count(snapshot.ready)}</dd></div>
        <div><dt>Awaiting acquisition handoff</dt><dd>{count(snapshot.awaitingHandoff)}</dd></div>
        <div><dt>Unfinished first collections</dt><dd>{count(snapshot.collecting)}</dd></div>
        <div><dt>Size review required</dt><dd>{count(snapshot.sizeReview)}</dd></div>
      </dl>
      <div className="ats-queue-persistence">
        <span>Normalization &amp; persistence: <strong>{count(snapshot.persistenceDue)} runnable items</strong> · <strong>{count(snapshot.persistenceHeld)} held items</strong></span>
        <span>Next scheduled attempt: <strong>{earliest ? atsRetryLabel(earliest, snapshot.observedAt) : 'No timed retry holds'}</strong></span>
      </div>
      <details className="ats-queue-holds">
        <summary>Hold reasons &amp; retry times · {count(snapshot.holds.length)} groups</summary>
        <p className="ats-queue-help">Each row counts its own stage. Jobs can appear in more than one stage; do not add these counts together. Times are Central. A scheduled attempt can be held again if the blocker remains. Acquisition handoff is checked every five minutes.</p>
        <label className="ats-queue-filter">Show stage
          <select value={stage} onChange={event => setStage(event.target.value)}>
            {['All stages', 'First collection', 'Validation', 'Size review', 'Persistence', 'Acquisition', 'Provider', 'Common Crawl'].map(value => <option key={value}>{value}</option>)}
          </select>
        </label>
        {visibleHolds.length === 0 ? <p>No held work in this view.</p> : (
          <div className="ats-queue-table-scroll">
            <table className="ats-queue-table">
              <thead><tr><th>Stage / provider</th><th>Held work</th><th>Why it is held</th><th>Next attempt</th></tr></thead>
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
      </details>
      <p className="ats-queue-observed">Observed {new Date(snapshot.observedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })} Central{unavailable ? ' · refresh unavailable' : ''}</p>
    </section>
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
