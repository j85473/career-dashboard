'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Play } from 'lucide-react';

import { showAlert } from '@/lib/modal';

type TrackingCoverage = 'untracked' | 'partial' | 'tracked';

interface DailyActivity {
  date: string;
  seen: number;
  ingested: number;
  duplicates: number;
  ingestionFiltered: number;
  processingErrors: number;
  sourceErrors: number;
  runCount: number;
  unreconciledRuns: number;
  ingestionReconciles: boolean;
  localPassed: number;
  localRejected: number;
  rejectedAE: number;
  passedAE: number;
  aeInboxAdmissions: number;
  humanPromoted: number;
  humanRejected: number;
  jdFailed: number;
  inbox: number;
  transitionTrackingStatus: TrackingCoverage;
  ingestionTrackingStatus: TrackingCoverage;
}

interface StatsData {
  asOf: {
    generatedAt: string;
    timeZone: string;
    ingestionControlAvailable: boolean;
    eventTrackingSince: string | null;
    ingestionTrackingSince: string | null;
    freshness: Record<string, string | null>;
  };
  operations: {
    pipeline: {
      isRunning: boolean;
      currentStep: string;
      stepProgress: string;
      lastUpdated: string;
      lockOwner: string | null;
      lockHeartbeatAt: string | null;
    } | null;
    scoringRequest: {
      id: string;
      status: string;
      phase: string;
      progress: string;
      heartbeatAt: string | null;
      updatedAt: string;
      error: string | null;
    } | null;
    queues: {
      local: number;
      needsJd: number;
      ae: number;
      context: number;
      actionNeeded: number;
    };
    tasks: {
      summary: {
        total: number;
        due: number;
        running: number;
        staleLeases: number;
        blockedBudget: number;
        failed: number;
        nextDueAt: string | null;
        latestWatermarkAt: string | null;
        updatedAt: string | null;
      };
      checkpoints: Array<{
        id: string;
        source: string;
        queryFamily: string | null;
        geoLane: string;
        ingestionMode: string;
        status: string;
        nextRunAt: string | null;
        windowStart: string | null;
        windowEnd: string | null;
        watermarkAt: string | null;
        leaseOwner: string | null;
        heartbeatAt: string | null;
        leaseExpiresAt: string | null;
        attempt: number;
        requestCount: number;
        seenCount: number;
        insertedCount: number;
        duplicateCount: number;
        filteredCount: number;
        processingErrorCount: number;
        providerErrorCount: number;
        lastError: string | null;
        lastCompletedAt: string | null;
        updatedAt: string | null;
        isDue: boolean;
        isStaleLease: boolean;
      }>;
    };
    circuits: Array<{
      provider: string;
      state: string;
      openUntil: string | null;
      consecutiveFailures: number;
      dailyLimit: number | null;
      monthlyLimit: number | null;
      dailyUsed: number;
      monthlyUsed: number;
      budgetDay: string | null;
      budgetMonth: string | null;
      lastError: string | null;
      lastFailureAt: string | null;
      lastSuccessAt: string | null;
      updatedAt: string | null;
    }>;
    incidents: Array<{
      provider: string;
      status: string;
      classifications: string[];
      incidentCount: number;
      affectedQueryCount: number;
      occurrenceCount: number;
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      message: string | null;
    }>;
    sourceHealth: Array<{
      source: string;
      lastSuccessAt: string | null;
      lastRunAt: string | null;
      failedRuns: number;
      idleRuns: number;
      totalRuns: number;
      insertedCount: number;
      requestErrors: number;
      processingErrors: number;
      unreconciledRuns: number;
    }>;
  };
  outcomes: {
    today: DailyActivity | null;
    trailing7Days: {
      seen: number;
      ingested: number;
      duplicates: number;
      ingestionFiltered: number;
      processingErrors: number;
      providerErrors: number;
      localPassed: number;
      localRejected: number;
      aePassed: number;
      aeRejected: number;
      humanPromoted: number;
      humanRejected: number;
      enteredInbox: number;
      localStageThroughputRatio: number | null;
      aePassRate: number | null;
      inboxStageThroughputRatio: number | null;
      unreconciledRuns: number;
    };
    daily: DailyActivity[];
  };
  calibration: {
    promptCohorts: Array<{
      promptVersion: string;
      evaluated: number;
      passed: number;
      passRate: number | null;
      averageAim: number;
      averageExperience: number;
      averageTravel: number;
      firstEvaluatedAt: string | null;
      lastEvaluatedAt: string | null;
    }>;
    travelBuckets: Array<{
      bucket: string;
      evaluated: number;
      passed: number;
      passRate: number | null;
      highTravelAimMisses: number;
      averageAim: number;
      averageExperience: number;
    }>;
    travelWatch: {
      atLeast50: number;
      atLeast75: number;
    };
  };
  inventory: {
    totalJobs: number;
    jobsByStatus: Array<{ name: string; count: number }>;
    jobsBySource: Array<{ name: string; count: number }>;
    averages: { aimFit: number; experienceFit: number };
    atsBoards: {
      total: number;
      active: number;
      parked: number;
      byPlatform: Array<{ name: string; active: number; parked: number }>;
    };
  };
}

interface StatsTabProps {
  onOpenTravelWatch?: () => void;
  onOpenActionNeeded?: () => void;
}

function number(value: number): string {
  return value.toLocaleString('en-US');
}

function percent(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function chicagoDateTime(value: string | null): string {
  if (!value) return 'not yet recorded';
  return new Date(value).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function age(value: string | null, reference: string): string {
  if (!value) return 'no telemetry';
  const elapsed = Math.max(0, new Date(reference).getTime() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function MetricCard({ label, value, note, tone = 'neutral' }: {
  label: string;
  value: React.ReactNode;
  note: string;
  tone?: 'neutral' | 'good' | 'warn' | 'danger' | 'travel';
}) {
  return (
    <article className={`ops-metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function StatePill({ value, danger = false }: { value: string; danger?: boolean }) {
  const stateClass = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return <span className={`ops-state-pill ${stateClass} ${danger ? 'danger' : ''}`}>{value.replaceAll('_', ' ')}</span>;
}

function SectionHeading({ eyebrow, title, note }: { eyebrow: string; title: string; note: string }) {
  return (
    <div className="ops-section-heading">
      <span>{eyebrow}</span>
      <div>
        <h2>{title}</h2>
        <p>{note}</p>
      </div>
    </div>
  );
}

export function StatsTab({ onOpenTravelWatch, onOpenActionNeeded }: StatsTabProps) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statsError, setStatsError] = useState('');
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [isDiscoveryRunning, setIsDiscoveryRunning] = useState(false);
  const terminalRef = useRef<HTMLPreElement>(null);

  const loadStats = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch('/api/stats', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to load dashboard metrics.');
      if (!payload?.asOf || !payload?.operations || !payload?.outcomes || !payload?.calibration) {
        throw new Error('The dashboard metric response was incomplete.');
      }
      setStats(payload);
      setStatsError('');
    } catch (error) {
      setStatsError(error instanceof Error ? error.message : 'Failed to load dashboard metrics.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => loadStats(), 0);
    const interval = setInterval(() => {
      if (!document.hidden) loadStats(true);
    }, 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [loadStats]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [terminalOutput]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/ats-companies/discover');
        if (!response.ok) return;
        const payload = await response.json();
        if (!cancelled) setIsDiscoveryRunning(payload.isRunning === true);
        if (!cancelled && Array.isArray(payload.logs)) {
          const next = payload.logs.map((line: string) => `${line}\n`);
          setTerminalOutput((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        }
      } catch {
        // Catalog discovery is an optional maintenance surface.
      } finally {
        if (!cancelled) timeout = setTimeout(fetchStatus, isDiscoveryRunning ? 3_000 : 15_000);
      }
    };
    fetchStatus();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [isDiscoveryRunning]);

  const startDiscovery = async () => {
    try {
      const response = await fetch('/api/ats-companies/discover', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to start ATS discovery.');
      setIsDiscoveryRunning(true);
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : 'Failed to start ATS discovery.');
    }
  };

  const stopDiscovery = async () => {
    try {
      const response = await fetch('/api/ats-companies/discover', { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to stop ATS discovery.');
      setIsDiscoveryRunning(false);
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : 'Failed to stop ATS discovery.');
    }
  };

  const latestFreshness = useMemo(() => {
    if (!stats) return null;
    const times = Object.values(stats.asOf.freshness)
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  }, [stats]);

  if (loading && !stats) {
    return <div className="ops-loading"><Loader className="spin" size={18} /> Loading operational metrics…</div>;
  }

  if (!stats) {
    return <div className="inline-error" role="alert">{statsError || 'Failed to load dashboard metrics.'}</div>;
  }

  const { operations, outcomes, calibration, inventory } = stats;
  const today = outcomes.today;
  const week = outcomes.trailing7Days;
  const openIncidents = operations.incidents.filter((incident) => incident.status === 'open');
  const openCircuits = operations.circuits.filter((circuit) => circuit.state !== 'closed');
  const describeAge = (value: string | null) => age(value, stats.asOf.generatedAt);
  const freshnessIsCurrent = Boolean(
    latestFreshness
    && new Date(stats.asOf.generatedAt).getTime() - new Date(latestFreshness).getTime() < 15 * 60_000,
  );
  const operationsAttention = operations.queues.actionNeeded
    + operations.tasks.summary.staleLeases
    + openIncidents.length;
  const attentionTasks = operations.tasks.checkpoints
    .filter((task) => task.isDue || task.status === 'running' || task.status === 'failed' || task.status === 'blocked_budget');
  const visibleTasks = (attentionTasks.length ? attentionTasks : operations.tasks.checkpoints).slice(0, 12);

  return (
    <div className="ops-dashboard">
      <header className="ops-dashboard-header">
        <div>
          <span className="ops-kicker">Source-backed control center</span>
          <h1>Job Search Operations</h1>
          <p>One view for pipeline health, search yield, scoring calibration, and travel-rich opportunities.</p>
        </div>
        <div className="ops-asof">
          <span className={freshnessIsCurrent ? 'fresh' : 'stale'}>
            {describeAge(latestFreshness)}
          </span>
          <small>As of {chicagoDateTime(stats.asOf.generatedAt)}</small>
          <button className="btn" onClick={() => loadStats()} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {!stats.asOf.ingestionControlAvailable && (
        <div className="ops-trust-warning" role="alert">
          Immutable event/task instrumentation is not available yet. Historical status-derived counts are intentionally not substituted.
        </div>
      )}
      {statsError && <div className="ops-trust-warning" role="alert">Refresh failed: {statsError}. Showing the last successful snapshot.</div>}

      <div className="ops-freshness-strip" aria-label="Metric source freshness">
        {([
          ['Source runs', stats.asOf.freshness.sourceRunsAt],
          ['Pipeline events', stats.asOf.freshness.pipelineEventsAt],
          ['Score events', stats.asOf.freshness.scoreEventsAt],
          ['Task checkpoints', stats.asOf.freshness.tasksAt],
          ['Provider circuits', stats.asOf.freshness.circuitsAt],
        ] satisfies Array<[string, string | null]>).map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{describeAge(value)}</strong>
          </div>
        ))}
      </div>

      <div className="ops-hero-grid">
        <MetricCard
          label="Entered Inbox today"
          value={number(today?.inbox || 0)}
          note="Actual A/E admissions + human promotions"
          tone="good"
        />
        <MetricCard
          label="7-day recommendations"
          value={number(week.enteredInbox)}
          note={`${percent(week.inboxStageThroughputRatio)} of seen-stage volume · not cohort conversion`}
          tone="good"
        />
        <MetricCard
          label="Due search tasks"
          value={number(operations.tasks.summary.due)}
          note={`${number(operations.tasks.summary.running)} running · ${number(operations.tasks.summary.blockedBudget)} budget-blocked`}
          tone={operations.tasks.summary.due > 0 ? 'warn' : 'neutral'}
        />
        <MetricCard
          label="Operations attention"
          value={number(operationsAttention)}
          note={`${number(operations.queues.actionNeeded)} scoring · ${number(openIncidents.length)} provider · ${number(operations.tasks.summary.staleLeases)} stale lease`}
          tone={operationsAttention > 0 ? 'danger' : 'good'}
        />
        <MetricCard
          label="High-travel watch"
          value={number(calibration.travelWatch.atLeast75)}
          note={`${number(calibration.travelWatch.atLeast50)} jobs at 50%+ travel`}
          tone="travel"
        />
      </div>

      <section className="ops-section">
        <SectionHeading
          eyebrow="Operations"
          title="What needs attention now"
          note="Task, lease, queue, provider, and checkpoint state—not inferred from job totals."
        />

        <div className="ops-status-grid">
          <article className="ops-panel">
            <div className="ops-panel-title">
              <h3>Pipeline</h3>
              <StatePill value={operations.pipeline?.isRunning ? 'running' : operations.pipeline?.currentStep || 'idle'} />
            </div>
            <strong>{operations.pipeline?.currentStep || 'No shared pipeline state'}</strong>
            <p>{operations.pipeline?.stepProgress || 'No pipeline run has reported state.'}</p>
            <dl className="ops-mini-dl">
              <div><dt>Heartbeat</dt><dd>{describeAge(operations.pipeline?.lockHeartbeatAt || operations.pipeline?.lastUpdated || null)}</dd></div>
              <div><dt>Lock owner</dt><dd>{operations.pipeline?.lockOwner || 'none'}</dd></div>
            </dl>
          </article>

          <article className="ops-panel">
            <div className="ops-panel-title">
              <h3>Native A/E scoring</h3>
              <StatePill value={operations.scoringRequest?.status || 'idle'} danger={operations.scoringRequest?.status === 'failed'} />
            </div>
            <strong>{operations.scoringRequest?.phase.replaceAll('_', ' ') || 'No scoring request'}</strong>
            <p>{operations.scoringRequest?.progress || 'A/E scoring is waiting for an explicit request.'}</p>
            <dl className="ops-mini-dl">
              <div><dt>Updated</dt><dd>{describeAge(operations.scoringRequest?.updatedAt || null)}</dd></div>
              <div><dt>Error</dt><dd>{operations.scoringRequest?.error || 'none'}</dd></div>
            </dl>
          </article>

          <article className="ops-panel ops-queue-panel">
            <div className="ops-panel-title"><h3>Scoring queues</h3></div>
            <dl className="ops-queue-grid">
              <div><dt>Local</dt><dd>{number(operations.queues.local)}</dd></div>
              <div><dt>Needs JD</dt><dd>{number(operations.queues.needsJd)}</dd></div>
              <div><dt>A/E</dt><dd>{number(operations.queues.ae)}</dd></div>
              <div><dt>Context</dt><dd>{number(operations.queues.context)}</dd></div>
              <div className={operations.queues.actionNeeded ? 'danger' : ''}><dt>Action needed</dt><dd>{number(operations.queues.actionNeeded)}</dd></div>
            </dl>
            <p>Failed, exhausted, or contradictory active jobs are excluded from normal queues.</p>
            <button className="ops-inline-link" onClick={onOpenActionNeeded}>Open Action Needed queue →</button>
          </article>
        </div>

        <div className="ops-two-column">
          <article className="ops-panel">
            <div className="ops-panel-title">
              <h3>Provider incidents</h3>
              <span>{openIncidents.length} open</span>
            </div>
            {operations.incidents.length === 0 ? (
              <div className="ops-empty">No recorded provider incidents.</div>
            ) : (
              <div className="ops-provider-list">
                {operations.incidents.map((incident) => (
                  <div key={`${incident.provider}:${incident.status}`} className="ops-provider-row">
                    <span>
                      <strong>{incident.provider}</strong>
                      <small>{incident.classifications.join(', ') || 'provider error'} · {number(incident.affectedQueryCount)} queries · {number(incident.occurrenceCount)} occurrences</small>
                      {incident.message && <em title={incident.message}>{incident.message}</em>}
                    </span>
                    <span>
                      <StatePill value={incident.status} danger={incident.status === 'open'} />
                      <small>{describeAge(incident.lastSeenAt)}</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </article>

          <article className="ops-panel">
            <div className="ops-panel-title">
              <h3>Provider circuits & budgets</h3>
              <span>{openCircuits.length} constrained</span>
            </div>
            {operations.circuits.length === 0 ? (
              <div className="ops-empty">No circuit state recorded.</div>
            ) : (
              <div className="ops-provider-list">
                {operations.circuits.map((circuit) => (
                  <div key={circuit.provider} className="ops-provider-row">
                    <span>
                      <strong>{circuit.provider}</strong>
                      <small>
                        Day {circuit.budgetDay || 'unset'}: {number(circuit.dailyUsed)}{circuit.dailyLimit == null ? '' : ` / ${number(circuit.dailyLimit)}`}
                        {' · '}Month {circuit.budgetMonth || 'unset'}: {number(circuit.monthlyUsed)}{circuit.monthlyLimit == null ? '' : ` / ${number(circuit.monthlyLimit)}`}
                      </small>
                      {circuit.lastError && <em title={circuit.lastError}>{circuit.lastError}</em>}
                    </span>
                    <span>
                      <StatePill value={circuit.state} danger={circuit.state === 'open'} />
                      <small>{circuit.openUntil ? `until ${chicagoDateTime(circuit.openUntil)}` : `${circuit.consecutiveFailures} failures`}</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </article>
        </div>

        <article className="ops-panel ops-table-panel">
          <div className="ops-panel-title">
            <h3>Due backlog & checkpoints</h3>
            <span>
              Next due {operations.tasks.summary.nextDueAt ? chicagoDateTime(operations.tasks.summary.nextDueAt) : 'not scheduled'}
              {' · '}watermark {operations.tasks.summary.latestWatermarkAt ? chicagoDateTime(operations.tasks.summary.latestWatermarkAt) : 'not established'}
            </span>
          </div>
          {visibleTasks.length === 0 ? (
            <div className="ops-empty">No durable search-task checkpoints have been recorded.</div>
          ) : (
            <div className="ops-table-scroll">
              <table className="ops-table">
                <thead>
                  <tr><th>Source / lane</th><th>Query family</th><th>Status</th><th>Checkpoint</th><th>Next run</th><th>Last outcome</th></tr>
                </thead>
                <tbody>
                  {visibleTasks.map((task) => (
                    <tr key={task.id} className={task.isStaleLease || task.status === 'failed' ? 'danger-row' : ''}>
                      <td><strong>{task.source}</strong><small>{task.geoLane} · {task.ingestionMode}</small></td>
                      <td>{task.queryFamily || 'default'}</td>
                      <td><StatePill value={task.isStaleLease ? 'stale_lease' : task.status} danger={task.isStaleLease || task.status === 'failed'} /></td>
                      <td>{task.watermarkAt ? chicagoDateTime(task.watermarkAt) : task.windowEnd ? chicagoDateTime(task.windowEnd) : 'not established'}</td>
                      <td>{task.isDue ? <strong className="ops-warn-text">due {describeAge(task.nextRunAt)}</strong> : chicagoDateTime(task.nextRunAt)}</td>
                      <td>
                        {number(task.insertedCount)} new · {number(task.duplicateCount)} duplicate
                        {task.lastError && <small title={task.lastError}>{task.lastError}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="ops-panel">
          <div className="ops-panel-title"><h3>Source health · trailing 7 days</h3></div>
          {operations.sourceHealth.length === 0 ? (
            <div className="ops-empty">Source health will populate from reconciled runs.</div>
          ) : (
            <div className="ops-source-grid">
              {operations.sourceHealth.map((source) => {
                const unhealthy = source.failedRuns > 0 || source.requestErrors > 0 || source.unreconciledRuns > 0;
                return (
                  <div key={source.source} className={unhealthy ? 'attention' : ''}>
                    <span><strong>{source.source}</strong><StatePill value={unhealthy ? 'review' : 'healthy'} danger={unhealthy} /></span>
                    <b>{number(source.insertedCount)} new</b>
                    <small>{number(source.totalRuns)} runs · {number(source.failedRuns)} failed · success {describeAge(source.lastSuccessAt)}</small>
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </section>

      <section className="ops-section">
        <SectionHeading
          eyebrow="Search outcomes"
          title="Where jobs move—or disappear"
          note="Stages use their own immutable timestamps. Cross-stage percentages are throughput ratios—not cohort conversion—because jobs can advance outside the seven-day window."
        />

        {week.unreconciledRuns > 0 && (
          <div className="ops-trust-warning" role="note">
            {number(week.unreconciledRuns)} source runs do not reconcile. Their counts remain visible but are flagged and excluded from trust claims.
          </div>
        )}

        <div className="ops-funnel" aria-label="Seven-day job search funnel">
          <div><span>Seen</span><strong>{number(week.seen)}</strong><small>source observations</small></div>
          <i aria-hidden>→</i>
          <div><span>New</span><strong>{number(week.ingested)}</strong><small>{percent(week.seen ? (week.ingested / week.seen) * 100 : null)} stage-throughput ratio</small></div>
          <i aria-hidden>→</i>
          <div><span>Local pass</span><strong>{number(week.localPassed)}</strong><small>{percent(week.localStageThroughputRatio)} stage-throughput ratio</small></div>
          <i aria-hidden>→</i>
          <div><span>A/E pass</span><strong>{number(week.aePassed)}</strong><small>{percent(week.aePassRate)} evaluated</small></div>
          <i aria-hidden>→</i>
          <div className="recommended"><span>Entered Inbox</span><strong>{number(week.enteredInbox)}</strong><small>actual admissions</small></div>
        </div>

        <article className="ops-panel ops-table-panel">
          <div className="ops-panel-title">
            <h3>Daily reconciled activity</h3>
            <span>
              Event tracking since {chicagoDateTime(stats.asOf.eventTrackingSince)} · ingestion tracking since {chicagoDateTime(stats.asOf.ingestionTrackingSince)}
            </span>
          </div>
          <div className="ops-table-scroll daily-table-scroll">
            <table className="ops-table ops-daily-table">
              <thead>
                <tr>
                  <th>Date</th><th>Seen</th><th>New</th><th>Duplicate</th><th>Filtered</th><th>Processing</th><th>Provider</th><th>Local pass</th><th>A/E pass</th><th>Entered Inbox</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.daily.map((day) => (
                  <tr key={day.date} className={!day.ingestionReconciles && day.runCount > 0 ? 'danger-row' : ''}>
                    <td>
                      <strong>{new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })}</strong>
                      <small>
                        {day.transitionTrackingStatus !== 'tracked' ? `${day.transitionTrackingStatus} events` : day.ingestionReconciles ? 'reconciled' : 'review totals'}
                      </small>
                    </td>
                    <td>{number(day.seen)}</td>
                    <td className="good-cell">{number(day.ingested)}</td>
                    <td>{number(day.duplicates)}</td>
                    <td>{number(day.ingestionFiltered)}</td>
                    <td className={day.processingErrors ? 'danger-cell' : ''}>{number(day.processingErrors)}</td>
                    <td className={day.sourceErrors ? 'danger-cell' : ''}>{number(day.sourceErrors)}</td>
                    <td>{number(day.localPassed)}<small>{number(day.localRejected)} rejected</small></td>
                    <td>{number(day.passedAE)}<small>{number(day.rejectedAE)} rejected</small></td>
                    <td className="good-cell">
                      <strong>{number(day.inbox)}</strong>
                      <small>{number(day.aeInboxAdmissions)} A/E · {number(day.humanPromoted)} human</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="ops-section">
        <SectionHeading
          eyebrow="Calibration & travel"
          title="Is scoring finding the work you actually want?"
          note="Latest non-stale evaluation per job; travel is a positive opportunity dimension, not an Experience penalty."
        />

        <div className="ops-travel-callout">
          <div>
            <span>Travel Watch</span>
            <strong>{number(calibration.travelWatch.atLeast75)} opportunities at 75%+ travel</strong>
            <p>Includes active and machine-dismissed scored jobs so promising travel-heavy false negatives stay reviewable.</p>
          </div>
          <button className="btn btn-primary" onClick={onOpenTravelWatch}>Open Travel Watch</button>
        </div>

        <div className="ops-two-column calibration-columns">
          <article className="ops-panel ops-table-panel">
            <div className="ops-panel-title"><h3>Prompt-version cohorts</h3><span>latest evaluation per job</span></div>
            {calibration.promptCohorts.length === 0 ? <div className="ops-empty">No current prompt cohorts.</div> : (
              <div className="ops-table-scroll">
                <table className="ops-table">
                  <thead><tr><th>Prompt</th><th>Evaluated</th><th>Passed</th><th>Pass rate</th><th>Avg A/E</th><th>Latest</th></tr></thead>
                  <tbody>
                    {calibration.promptCohorts.map((cohort) => (
                      <tr key={cohort.promptVersion}>
                        <td><strong>{cohort.promptVersion}</strong></td>
                        <td>{number(cohort.evaluated)}</td>
                        <td>{number(cohort.passed)}</td>
                        <td>{percent(cohort.passRate)}</td>
                        <td>{cohort.averageAim} / {cohort.averageExperience}</td>
                        <td>{describeAge(cohort.lastEvaluatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="ops-panel ops-table-panel travel-calibration-panel">
            <div className="ops-panel-title"><h3>Travel calibration</h3><span>higher travel is preferred</span></div>
            {calibration.travelBuckets.length === 0 ? <div className="ops-empty">No current travel evaluations.</div> : (
              <div className="ops-table-scroll">
                <table className="ops-table">
                  <thead><tr><th>Travel</th><th>Evaluated</th><th>Passed</th><th>Pass rate</th><th>High-travel Aim misses</th></tr></thead>
                  <tbody>
                    {calibration.travelBuckets.map((bucket) => (
                      <tr key={bucket.bucket} className={bucket.bucket.startsWith('75') || bucket.bucket.startsWith('90') ? 'travel-row' : ''}>
                        <td><strong>{bucket.bucket}</strong></td>
                        <td>{number(bucket.evaluated)}</td>
                        <td>{number(bucket.passed)}</td>
                        <td>{percent(bucket.passRate)}</td>
                        <td>{number(bucket.highTravelAimMisses)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </div>
      </section>

      <details className="ops-details">
        <summary>Inventory and ATS catalog</summary>
        <div className="ops-inventory-grid">
          <article className="ops-panel">
            <div className="ops-panel-title"><h3>Job inventory</h3><strong>{number(inventory.totalJobs)}</strong></div>
            <div className="ops-compact-list">
              {inventory.jobsByStatus.map((status) => <div key={status.name}><span>{status.name.replaceAll('_', ' ')}</span><strong>{number(status.count)}</strong></div>)}
            </div>
          </article>
          <article className="ops-panel">
            <div className="ops-panel-title"><h3>Top sources</h3></div>
            <div className="ops-compact-list">
              {[...inventory.jobsBySource].sort((a, b) => b.count - a.count).slice(0, 12).map((source) => <div key={source.name}><span>{source.name}</span><strong>{number(source.count)}</strong></div>)}
            </div>
          </article>
          <article className="ops-panel">
            <div className="ops-panel-title"><h3>ATS boards</h3><strong>{number(inventory.atsBoards.active)} active</strong></div>
            <div className="ops-compact-list">
              {inventory.atsBoards.byPlatform.map((platform) => <div key={platform.name}><span>{platform.name}</span><strong>{number(platform.active)} / {number(platform.parked)}</strong></div>)}
            </div>
          </article>
        </div>
      </details>

      <details className="ops-details">
        <summary>ATS catalog discovery maintenance</summary>
        <div className="ops-discovery-head">
          <p>This expands the employer-board catalog; it is not the recurring job ingestion scheduler.</p>
          <div>
            {isDiscoveryRunning && <button className="btn btn-danger" onClick={stopDiscovery}>Stop discovery</button>}
            <button className="btn btn-primary" onClick={startDiscovery} disabled={isDiscoveryRunning}>
              {isDiscoveryRunning ? <Loader className="spin" size={16} /> : <Play size={16} />}
              {isDiscoveryRunning ? 'Running…' : 'Run discovery'}
            </button>
          </div>
        </div>
        <pre ref={terminalRef} className="ops-terminal">
          {terminalOutput.length ? terminalOutput.join('') : 'Ready. Discovery logs will appear here.'}
        </pre>
      </details>
    </div>
  );
}
