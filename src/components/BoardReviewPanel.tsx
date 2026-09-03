'use client';

import React, { useEffect, useState } from 'react';

/**
 * The weekly board-pruning review, on the Dashboard.
 *
 * The review has always produced these numbers and always printed them to the
 * system journal. Nobody reads a journal, which is how the demoted board tier
 * grew larger than the active catalog without anyone noticing for weeks. The
 * point of this panel is that the number is in front of Joseph whether or not
 * he goes looking.
 */

type Applied = {
  promoted: number;
  excluded: number;
  retirementBlocked: string | null;
  writeFailures: number;
};

type Arm = {
  arm: string;
  reversible: boolean;
  summary: string;
  boards?: number;
  approvalCommand?: string;
  applied?: Applied;
  error?: string;
};

type Review = {
  generatedAt?: string;
  totals?: { candidateBoards?: number };
  arms?: Arm[];
};

type Payload =
  | { available: true; report: Review }
  | { available: false; reason: string };

const ARM_LABELS: Record<string, string> = {
  board_liveness: 'Boards contacted this week',
  never_relevant_geography: 'Only ever posts outside the search area',
  unproductive_or_out_of_territory: 'Nothing survives triage',
  low_yield_demotion: 'Slowed down rather than retired',
};

function label(arm: string): string {
  return ARM_LABELS[arm] || arm.replace(/_/g, ' ');
}

function describeAge(iso: string, now: number): string {
  const days = Math.floor((now - new Date(iso).valueOf()) / 86_400_000);
  if (Number.isNaN(days)) return 'at an unknown time';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function BoardReviewPanel() {
  const [payload, setPayload] = useState<Payload | null>(null);
  // Captured when the report arrives rather than read during render: "how long
  // ago" is a property of the fetch, and reading the clock while rendering is
  // impure.
  const [loadedAt, setLoadedAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ats-companies/board-review')
      .then((response) => response.json() as Promise<Payload>)
      .then((data) => { if (!cancelled) { setLoadedAt(Date.now()); setPayload(data); } })
      .catch(() => {
        if (cancelled) return;
        setLoadedAt(Date.now());
        setPayload({ available: false, reason: 'The board review could not be loaded.' });
      });
    return () => { cancelled = true; };
  }, []);

  if (!payload) return null;

  if (!payload.available) {
    return (
      <article className="ops-panel">
        <div className="ops-panel-title"><h3>Weekly board review</h3></div>
        <p>{payload.reason}</p>
      </article>
    );
  }

  const review = payload.report;
  const arms = review.arms || [];
  const liveness = arms.find((arm) => arm.arm === 'board_liveness');
  const waiting = arms.filter((arm) => arm.approvalCommand);
  const generated = review.generatedAt;
  // A review that has not run for over a fortnight is itself the finding: the
  // timer is weekly, so two missed cycles means it is not running at all.
  const stale = generated ? loadedAt - new Date(generated).valueOf() > 14 * 86_400_000 : false;

  return (
    <article className="ops-panel">
      <div className="ops-panel-title">
        <h3>Weekly board review</h3>
        <span>{generated ? `ran ${describeAge(generated, loadedAt)}` : 'never run'}</span>
      </div>

      {stale && (
        <div className="ops-trust-warning" role="note">
          The last review is over a fortnight old. It runs every Monday, so this means the timer is
          not running rather than that there was nothing to report.
        </div>
      )}

      {liveness?.applied && (
        <div className="ops-ats-summary">
          <div>
            <span>Returned to rotation</span>
            <strong>{liveness.applied.promoted.toLocaleString('en-US')}</strong>
            <small>demoted boards that answered with live postings</small>
          </div>
          <div>
            <span>Retired</span>
            <strong>{liveness.applied.excluded.toLocaleString('en-US')}</strong>
            <small>boards the provider no longer hosts</small>
          </div>
        </div>
      )}

      {liveness?.applied?.retirementBlocked && (
        <div className="ops-trust-warning" role="note">
          <strong>Nothing was retired this week.</strong> {liveness.applied.retirementBlocked}
        </div>
      )}

      {(liveness?.applied?.writeFailures ?? 0) > 0 && (
        <div className="ops-trust-warning" role="note">
          {liveness?.applied?.writeFailures.toLocaleString('en-US')} board(s) could not be written and
          are still in the rotation. The run is in the journal.
        </div>
      )}

      {liveness?.error && (
        <div className="ops-trust-warning" role="note">
          The liveness sweep failed: {liveness.error}
        </div>
      )}

      {waiting.length > 0 && (
        <>
          <p>
            Waiting on you. A retired board is never re-judged, so these are reported rather than
            applied; the exact command for each is in the review.
          </p>
          <div className="ops-table-scroll">
            <table className="ops-table">
              <thead><tr><th>Finding</th><th>Boards</th><th>Reversible</th></tr></thead>
              <tbody>
                {waiting.map((arm) => (
                  <tr key={arm.arm}>
                    <td><strong>{label(arm.arm)}</strong><br /><small>{arm.summary}</small></td>
                    <td>{(arm.boards || 0).toLocaleString('en-US')}</td>
                    <td>{arm.reversible ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {waiting.length === 0 && !liveness?.applied && (
        <p>The last review found nothing to change.</p>
      )}
    </article>
  );
}
