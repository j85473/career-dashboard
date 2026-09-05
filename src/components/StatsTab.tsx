'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Play } from 'lucide-react';

import { showAlert } from '@/lib/modal';
import { normalizeStatsTaskContract } from '@/lib/statsClientContract';
import { startClientPolling, type ClientPolling } from '@/lib/clientPolling';
import { readClientMutationResponse } from '@/lib/clientMutationResponse';
import { BoardReviewPanel } from './BoardReviewPanel';

type TrackingCoverage = 'untracked' | 'partial' | 'tracked';

type MetricUnavailableReason =
  | 'not_instrumented'
  | 'no_matching_evaluations'
  | 'no_data_in_window'
  | 'not_captured';

const UNAVAILABLE_COPY: Record<MetricUnavailableReason, string> = {
  not_instrumented: 'not instrumented',
  no_matching_evaluations: 'nothing evaluated yet',
  no_data_in_window: 'no data in window',
  not_captured: 'not being measured',
};

const UNAVAILABLE_DETAIL: Record<MetricUnavailableReason, string> = {
  not_instrumented: 'No code path writes this event. The number is missing, not zero.',
  no_matching_evaluations: 'No evaluation currently matches the active scoring version.',
  no_data_in_window: 'Nothing was recorded in the selected time window.',
  not_captured: 'The scoring run completed but never populated this dimension.',
};

interface MetricValue {
  value: number | null;
  unavailable: MetricUnavailableReason | null;
}

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

interface WindowTotals {
  days: number;
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
}

interface AllTimeTotals {
  since: string | null;
  seen: number;
  ingested: number;
  duplicates: number;
  filtered: number;
  providerErrors: number;
  processingErrors: number;
  runs: number;
  enteredInbox: number;
  inboxSince: string | null;
  seenSinceInboxTracking: number;
  inboxRate: number | null;
  applied: number;
  interviewing: number;
}

type SourceVerdict = 'failing' | 'degraded' | 'silent' | 'healthy';

interface SourceHealth {
  source: string;
  verdict: SourceVerdict;
  reason: string;
  lastSuccessAt: string | null;
  lastProductiveAt: string | null;
  lastRunAt: string | null;
  productiveAgeHours: number | null;
  failedRuns: number;
  partialRuns: number;
  productiveRuns: number;
  seenCount: number;
  duplicateCount: number;
  recentRuns: number;
  recentRequestErrors: number;
  recentFailedRuns: number;
  idleRuns: number;
  totalRuns: number;
  failureRate: number | null;
  insertedCount: number;
  requestErrors: number;
  processingErrors: number;
  unreconciledRuns: number;
  lifetime: {
    totalRuns: number;
    failedRuns: number;
    insertedCount: number;
    seenCount: number;
    requestErrors: number;
    firstRunAt: string | null;
  } | null;
}

type TaskCategory = 'running' | 'runnableNow' | 'scheduled' | 'circuitCooldown'
  | 'budgetBlocked' | 'failedAwaitingRetry' | 'staleLease' | 'retired' | 'orchestration';

interface OperationalTask {
  id: string;
  source: string;
  queryFamily: string | null;
  geoLane: string;
  ingestionMode: string;
  taskKind: string;
  lifecycleStatus: string;
  retiredAt: string | null;
  status: string;
  category: TaskCategory;
  nextRunAt: string | null;
  availableAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  watermarkAt: string | null;
  leaseOwner: string | null;
  leaseStartedAt: string | null;
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
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  cursor: Record<string, unknown> | null;
  updatedAt: string | null;
  isDue: boolean;
  isStaleLease: boolean;
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
    scoringBatch: {
      id: string;
      stage: string;
      status: string;
      imported: number;
      total: number;
      createdAt: string;
      expiresAt: string;
    } | null;
    queues: {
      local: number;
      needsJd: number;
      aim: number;
      experience: number;
      context: number;
      actionNeeded: number;
    };
    tasks: {
      summary: {
        activeSearchTasks: number;
        categoryReconciles: boolean;
        runnableNow: number;
        running: number;
        scheduled: number;
        staleLeases: number;
        circuitCooldown: number;
        blockedBudget: number;
        failedAwaitingRetry: number;
        retired: number;
        orchestration: number;
        oldestRunnableSince: string | null;
        nextRunnableAt: string | null;
        latestWatermarkAt: string | null;
        updatedAt: string | null;
      };
      checkpoints: OperationalTask[];
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
    sourceHealth: SourceHealth[];
    failingSources: SourceHealth[];
  };
  outcomes: {
    today: DailyActivity | null;
    trailing7Days: WindowTotals;
    trailing30Days: WindowTotals;
    allTime: AllTimeTotals;
    daily: DailyActivity[];
    stageCoverage: {
      local: MetricUnavailableReason | null;
      ae: MetricUnavailableReason | null;
      human: MetricUnavailableReason | null;
      jdFailed: MetricUnavailableReason | null;
    };
  };
  calibration: {
    promptCohorts: Array<{
      evaluationType: string;
      promptVersion: string;
      evaluated: number;
      passed: number;
      passRate: number | null;
      averageAim: number;
      averageExperience: number;
      firstEvaluatedAt: string | null;
      lastEvaluatedAt: string | null;
    }>;
    population: { aim: number; experience: number };
  };
  inventory: {
    totalJobs: number;
    jobsByStatus: Array<{ name: string; count: number }>;
    jobsBySource: Array<{ name: string; count: number }>;
    averages: { aimFit: MetricValue; experienceFit: MetricValue };
    atsBoards: {
      total: number;
      active: number;
      parked: number;
      blacklisted: number;
      byStatus: Array<{ name: string; count: number }>;
      dueForCheck: number;
      jobsFoundAtLastCheck: number;
      coverageSlo: {
        activeBoards: number;
        rotationDays: number;
        boardsCheckedWithinCycle: number;
        boardsOutsideCycle: number;
        boardsNeverChecked: number;
        coverageRatio: number;
        objective: number;
        requiredChecksPerDay: number;
        oldestCheckedAgeDays: number | null;
        status: 'healthy' | 'at_risk' | 'breached';
        breachReasons: string[];
      };
      path: {
        available: boolean;
        enabled: boolean;
        dailyTarget: number;
        attemptedToday: number;
        legacyClaimContactedToday: number;
        newCycleListingContactedToday: number;
        listingContinuationContactedToday: number;
        contactMetricEffectiveAt: string | null;
        admissionState: string;
        distributedAuthorityActivatedAt: string | null;
        remoteWorkersEnabled: boolean;
        globalSlotLimit: number;
        localSlotReserve: number;
        activePiSlots: number;
        activeMacSlots: number;
        cutoverReadyAt: string | null;
        respondedToday: number;
        synchronizedToday: number;
        processedToday: number;
        failedToday: number;
        remainingJobs: number;
        backpressureJobs: number;
        oldestSynchronizedAt: string | null;
        processedJobsLastHour: number;
        fetchedJobsLastHour: number;
        queuedJobsLastHour: number;
        prequeueDuplicatesLastHour: number;
        deferredWithoutContactLastHour: number;
        lastAttemptedAt: string | null;
        lastRespondedAt: string | null;
        lastSynchronizedAt: string | null;
        lastProcessedAt: string | null;
        queue: {
          fetching: number;
          partial: number;
          queued: number;
          processing: number;
          failed: number;
        };
      };
      byPlatform: Array<{ name: string; active: number; parked: number; blacklisted: number; total: number }>;
    };
  };
}

interface StatsTabProps {
  onOpenActionNeeded?: () => void;
}

function number(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : '—';
}

function compact(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < 10_000) return value.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value !== 0 && Math.abs(value) < 0.05) return `${value.toFixed(3)}%`;
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

/**
 * Renders a metric that may legitimately have no value behind it. A missing
 * measurement and a measured zero must never look the same.
 */
function Metric({ metric, format = number }: {
  metric: MetricValue | undefined;
  format?: (value: number | null | undefined) => string;
}) {
  if (!metric || metric.unavailable) {
    const reason = metric?.unavailable || 'no_data_in_window';
    return (
      <span className="ops-metric-unavailable" title={UNAVAILABLE_DETAIL[reason]}>
        {UNAVAILABLE_COPY[reason]}
      </span>
    );
  }
  return <>{format(metric.value)}</>;
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

function chicagoDate(value: string | null): string {
  if (!value) return 'unknown';
  return new Date(value).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** How long ago the served snapshot was actually measured, in plain words. */
function describeSnapshotAge(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function age(value: string | null, reference: string): string {
  if (!value) return 'never';
  const elapsedMs = Math.max(0, new Date(reference).getTime() - new Date(value).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function elapsed(value: string | null, reference: string): string {
  if (!value) return 'not recorded';
  const milliseconds = Math.max(0, new Date(reference).getTime() - new Date(value).getTime());
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function MetricCard({ label, value, note, tone = 'neutral', onClick }: {
  label: string;
  value: React.ReactNode;
  note: React.ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
  onClick?: () => void;
}) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </>
  );
  if (onClick) {
    return <button type="button" className={`ops-metric-card ${tone} clickable`} onClick={onClick}>{content}</button>;
  }
  return <article className={`ops-metric-card ${tone}`}>{content}</article>;
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

/** One stage of the ingestion funnel, with an explicit "nothing writes this" state. */
function FunnelStage({ label, value, sub, unavailable, highlight = false }: {
  label: string;
  value: number;
  sub: React.ReactNode;
  unavailable?: MetricUnavailableReason | null;
  highlight?: boolean;
}) {
  return (
    <div className={highlight ? 'recommended' : undefined}>
      <span>{label}</span>
      {unavailable
        ? (
          <strong className="ops-metric-unavailable" title={UNAVAILABLE_DETAIL[unavailable]}>
            {UNAVAILABLE_COPY[unavailable]}
          </strong>
        )
        : <strong>{number(value)}</strong>}
      <small>{unavailable ? 'stage not reporting' : sub}</small>
    </div>
  );
}

function taskAvailability(task: OperationalTask, generatedAt: string): React.ReactNode {
  if (task.category === 'running' || task.category === 'staleLease') {
    return <>{elapsed(task.leaseStartedAt || task.lastStartedAt, generatedAt)} elapsed<small>heartbeat {age(task.heartbeatAt, generatedAt)}</small></>;
  }
  if (task.category === 'runnableNow') {
    return <strong className="ops-warn-text">eligible for {elapsed(task.nextRunAt, generatedAt)}</strong>;
  }
  if (task.category === 'circuitCooldown' || task.category === 'budgetBlocked') {
    return <>blocked until {chicagoDateTime(task.availableAt)}</>;
  }
  if (task.category === 'failedAwaitingRetry') {
    return <>retry at {chicagoDateTime(task.availableAt)}</>;
  }
  return chicagoDateTime(task.availableAt);
}

function TaskTable({ tasks, total, generatedAt, empty }: {
  tasks: OperationalTask[];
  total: number;
  generatedAt: string;
  empty: string;
}) {
  const visible = tasks.slice(0, 12);
  if (!visible.length) return <div className="ops-empty">{empty}</div>;
  return (
    <>
      <div className="ops-table-scroll">
        <table className="ops-table">
          <thead><tr><th>Source / lane</th><th>Query family</th><th>State</th><th>Availability</th><th>Progress / checkpoint</th><th>Last outcome</th></tr></thead>
          <tbody>
            {visible.map((task) => {
              const cursor = task.cursor || {};
              const progress = typeof cursor.completedCount === 'number'
                ? `${cursor.completedCount} / ${String(cursor.selectedCount || 0)} boards`
                : task.watermarkAt ? chicagoDateTime(task.watermarkAt) : 'not established';
              return (
                <tr key={task.id} className={task.category === 'staleLease' || task.status === 'failed' ? 'danger-row' : ''}>
                  <td><strong>{task.source}</strong><small>{task.geoLane} · {task.ingestionMode}</small></td>
                  <td>{task.queryFamily || 'default'}</td>
                  <td><StatePill value={task.category} danger={task.category === 'staleLease' || task.status === 'failed'} /></td>
                  <td>{taskAvailability(task, generatedAt)}</td>
                  <td>{progress}{typeof cursor.currentBoard === 'string' && cursor.currentBoard ? <small>{cursor.currentBoard}</small> : null}</td>
                  <td>{number(task.insertedCount)} new · {number(task.duplicateCount)} duplicate{task.lastError && <small title={task.lastError}>{task.lastError}</small>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <small className="ops-table-disclosure">Showing {visible.length} of {total} tasks.</small>
    </>
  );
}

const SOURCE_VERDICT_TONE: Record<SourceVerdict, string> = {
  failing: 'danger',
  silent: 'warn',
  degraded: 'warn',
  healthy: 'good',
};

function SourceRow({ source, generatedAt }: { source: SourceHealth; generatedAt: string }) {
  return (
    <div className={`ops-source-row ${SOURCE_VERDICT_TONE[source.verdict]}`}>
      <span className="ops-source-name">
        <strong>{source.source}</strong>
        <StatePill value={source.verdict} danger={source.verdict === 'failing'} />
      </span>
      <span className="ops-source-reason">{source.reason}</span>
      <span className="ops-source-numbers">
        <b>{number(source.insertedCount)}</b> new · {number(source.totalRuns)} runs
        <small>
          {/* Last time it actually produced a job, not the last time a run
              happened to be labelled "success" — those are different things. */}
          last job {age(source.lastProductiveAt, generatedAt)}
          {source.lifetime ? ` · ${compact(source.lifetime.insertedCount)} all time` : ''}
        </small>
      </span>
    </div>
  );
}

export function StatsTab({ onOpenActionNeeded }: StatsTabProps) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statsError, setStatsError] = useState('');
  const [snapshotAge, setSnapshotAge] = useState<{ seconds: number; from: string } | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [isDiscoveryRunning, setIsDiscoveryRunning] = useState(false);
  const [discoveryAction, setDiscoveryAction] = useState<'start' | 'stop' | null>(null);
  const [showRetiredTasks, setShowRetiredTasks] = useState(false);
  const [showHealthySources, setShowHealthySources] = useState(false);
  const terminalRef = useRef<HTMLPreElement>(null);
  const statsPollingRef = useRef<ClientPolling | null>(null);
  const discoveryPollingRef = useRef<ClientPolling | null>(null);
  const discoveryActionRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const polling = startClientPolling({
      request: async (signal) => {
        if (document.hidden) return null;
        const response = await fetch('/api/stats', { cache: 'no-store', signal });
        const payload = normalizeStatsTaskContract(await response.json().catch(() => ({})));
        if (!response.ok) throw new Error(payload.error || 'Failed to load dashboard metrics.');
        if (!payload?.asOf || !payload?.operations?.tasks?.summary || !payload?.outcomes || !payload?.calibration) {
          throw new Error('The dashboard metric response was incomplete.');
        }
        // The server answers from a retained snapshot, so the numbers below can
        // be older than the request that fetched them. Carry that age back with
        // the payload rather than letting a stale reading pass as current.
        return {
          payload,
          servedAgeSeconds: Number(response.headers.get('x-career-stats-age') || 0),
          servedFrom: response.headers.get('x-career-stats-cache') || '',
        };
      },
      onData: (result) => {
        if (!result) return;
        setStats(result.payload);
        setSnapshotAge({ seconds: result.servedAgeSeconds, from: result.servedFrom });
        setStatsError('');
        setLoading(false);
        setRefreshing(false);
      },
      onError: (error) => {
        setStatsError(error instanceof Error ? error.message : 'Failed to load dashboard metrics.');
        setLoading(false);
        setRefreshing(false);
      },
      intervalMs: () => 30_000,
    });
    statsPollingRef.current = polling;
    return () => {
      polling.stop();
      statsPollingRef.current = null;
    };
  }, []);

  const refreshStats = () => {
    setRefreshing(true);
    statsPollingRef.current?.refresh();
  };

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [terminalOutput]);

  useEffect(() => {
    // Do not let a pre-action status response overwrite a start/stop acknowledgement.
    if (discoveryAction) return;
    const polling = startClientPolling({
      request: async (signal) => {
        const response = await fetch('/api/ats-companies/discover', { signal });
        if (!response.ok) throw new Error('Could not load discovery status.');
        return await response.json() as { isRunning: boolean; logs?: unknown[] };
      },
      onData: (payload) => {
        setIsDiscoveryRunning(payload.isRunning === true);
        if (Array.isArray(payload.logs)) {
          const next = payload.logs.filter((line): line is string => typeof line === 'string').map((line) => `${line}\n`);
          setTerminalOutput((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        }
      },
      intervalMs: () => isDiscoveryRunning ? 3_000 : 15_000,
    });
    discoveryPollingRef.current = polling;
    return () => {
      polling.stop();
      discoveryPollingRef.current = null;
    };
  }, [isDiscoveryRunning, discoveryAction]);

  useEffect(() => () => {
    discoveryActionRef.current?.abort();
    discoveryActionRef.current = null;
  }, []);

  const changeDiscovery = async (action: 'start' | 'stop') => {
    if (discoveryActionRef.current) return;
    const controller = new AbortController();
    discoveryActionRef.current = controller;
    discoveryPollingRef.current?.stop();
    setDiscoveryAction(action);
    try {
      const response = await fetch('/api/ats-companies/discover', {
        method: action === 'start' ? 'POST' : 'DELETE',
        signal: controller.signal,
      });
      const payload = await readClientMutationResponse(response, `Failed to ${action} ATS discovery.`);
      if (payload.status !== (action === 'start' ? 'started' : 'stopped')) {
        throw new Error('Discovery returned an unexpected response. Check its status before trying again.');
      }
      if (!controller.signal.aborted) setIsDiscoveryRunning(action === 'start');
    } catch (error) {
      if (!controller.signal.aborted) {
        await showAlert(error instanceof Error ? error.message : `Failed to ${action} ATS discovery.`);
      }
    } finally {
      if (discoveryActionRef.current === controller) {
        discoveryActionRef.current = null;
        setDiscoveryAction(null);
      }
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
    return <div className="ops-loading"><Loader className="spin" size={18} /> Loading dashboard…</div>;
  }

  if (!stats) {
    return <div className="inline-error" role="alert">{statsError || 'Failed to load dashboard metrics.'}</div>;
  }

  const { operations, outcomes, calibration, inventory } = stats;
  const generatedAt = stats.asOf.generatedAt;
  const today = outcomes.today;
  const week = outcomes.trailing7Days;
  const month = outcomes.trailing30Days;
  const allTime = outcomes.allTime;
  const boards = inventory.atsBoards;
  const atsPath = boards.path;
  const atsAcquisitionBacklog = atsPath.queue.fetching + atsPath.queue.partial;
  const atsProcessingBacklog = atsPath.queue.queued + atsPath.queue.processing;
  const summary = operations.tasks.summary;
  const openIncidents = operations.incidents.filter((incident) => incident.status === 'open');
  const openCircuits = operations.circuits.filter((circuit) => circuit.state !== 'closed');
  const describeAge = (value: string | null) => age(value, generatedAt);
  const freshnessIsCurrent = Boolean(
    latestFreshness
    && new Date(generatedAt).getTime() - new Date(latestFreshness).getTime() < 15 * 60_000,
  );

  const failingSources = operations.failingSources || [];
  const hardFailures = failingSources.filter((source) => source.verdict === 'failing');
  // The rotation SLO is computed server-side and can be absent on an older
  // deployment. A missing objective must read as unmeasured, never as met.
  const coverage = boards.coverageSlo || {
    activeBoards: boards.active,
    rotationDays: 7,
    boardsCheckedWithinCycle: 0,
    boardsOutsideCycle: 0,
    boardsNeverChecked: 0,
    coverageRatio: 0,
    objective: 0.99,
    requiredChecksPerDay: 0,
    oldestCheckedAgeDays: null,
    status: 'breached' as const,
    breachReasons: ['Rotation coverage is not being measured by this deployment.'],
  };

  /**
   * Only the things a person can act on.
   *
   * The old attention tile summed the scoring backlog into a number with
   * Joseph's name on it, so 611 jobs the machine works through on its own read
   * as 611 things he was neglecting. Backlog and scheduler cooldowns belong to
   * the machine and are reported under whether it is keeping up.
   */
  const jobsInInbox = inventory.jobsByStatus.find((entry) => entry.name === 'inbox')?.count || 0;

  const attentionItems: Array<{
    id: string;
    kind: string;
    severe: boolean;
    title: string;
    detail: string;
    onClick?: () => void;
  }> = [
    // Scoring that gave up is a fault, not a queue. It sat in a tile labelled
    // "needs your attention" whose number was really the machine's own error
    // backlog.
    ...(operations.queues.actionNeeded > 0 ? [{
      id: 'scoring:action-needed',
      kind: 'scoring failed',
      severe: false,
      title: `${number(operations.queues.actionNeeded)} jobs could not be scored`,
      detail: 'the description was rejected, or Aim or Experience could not produce a verdict',
      onClick: onOpenActionNeeded,
    }] : []),
    ...hardFailures.map((source) => ({
      id: `source:${source.source}`,
      kind: 'source stopped',
      severe: true,
      title: source.source,
      detail: source.reason,
    })),
    ...openIncidents.map((incident) => ({
      id: `incident:${incident.provider}`,
      kind: 'provider incident',
      severe: true,
      title: incident.provider,
      detail: incident.message || incident.classifications.join(', ') || 'provider error',
    })),
    ...openCircuits.map((circuit) => ({
      id: `circuit:${circuit.provider}`,
      kind: 'breaker open',
      severe: circuit.state === 'open',
      title: circuit.provider,
      detail: circuit.openUntil
        ? `paused until ${chicagoDateTime(circuit.openUntil)}${circuit.lastError ? ` — ${circuit.lastError}` : ''}`
        : circuit.lastError || `${circuit.consecutiveFailures} consecutive failures`,
    })),
  ];
  const healthySources = operations.sourceHealth.filter((source) => source.verdict === 'healthy');
  const scoringBacklog = operations.queues.needsJd + operations.queues.aim + operations.queues.experience;

  const runningTasks = operations.tasks.checkpoints.filter((task) => task.category === 'running' || task.category === 'staleLease');
  const runnableTasks = operations.tasks.checkpoints.filter((task) => task.category === 'runnableNow');
  const blockedTasks = operations.tasks.checkpoints.filter((task) => ['circuitCooldown', 'budgetBlocked', 'failedAwaitingRetry'].includes(task.category));
  const recentCheckpoints = operations.tasks.checkpoints
    .filter((task) => task.lifecycleStatus === 'active' && task.taskKind === 'search' && ['scheduled', 'failedAwaitingRetry'].includes(task.category))
    .sort((a, b) => new Date(b.lastCompletedAt || 0).getTime() - new Date(a.lastCompletedAt || 0).getTime());
  const retiredTasks = operations.tasks.checkpoints.filter((task) => task.category === 'retired' || task.category === 'orchestration');

  return (
    <div className="ops-dashboard">
      <header className="ops-dashboard-header">
        <div>
          <span className="ops-kicker">Job search operations</span>
          <h1>Dashboard</h1>
          <p>What it delivered, what needs you, and whether it is keeping up. Everything else is one click down.</p>
        </div>
        <div className="ops-asof">
          <span className={freshnessIsCurrent ? 'fresh' : 'stale'}>{describeAge(latestFreshness)}</span>
          <small>As of {chicagoDateTime(generatedAt)}</small>
          <button className="btn" onClick={refreshStats} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {!stats.asOf.ingestionControlAvailable && (
        <div className="ops-trust-warning" role="alert">
          Event and task instrumentation tables are missing. Nothing below is backed by real telemetry.
        </div>
      )}
      {statsError && <div className="ops-trust-warning" role="alert">Refresh failed: {statsError}. Showing the last good snapshot.</div>}
      {snapshotAge && snapshotAge.seconds >= 120 && (
        <div className="ops-trust-warning" role="alert">
          {snapshotAge.from === 'expired'
            ? `Every number below was measured ${describeSnapshotAge(snapshotAge.seconds)} ago and could not be rebuilt on request. The dashboard is showing the last reading it managed to take, not the current one.`
            : `Every number below was measured ${describeSnapshotAge(snapshotAge.seconds)} ago. A rebuild is running; refresh in a moment for current figures.`}
        </div>
      )}
      {!summary.categoryReconciles && (
        <div className="ops-trust-warning" role="alert">
          Scheduler task counts do not add up to the number of active search tasks. Treat the task numbers below as unreliable.
        </div>
      )}

      {/* ── 1. Results ───────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="Results"
          title={`Did it deliver anything · ${chicagoDate(generatedAt)}`}
          note="What the machine produced for you, since midnight Central. These are the only numbers on this page you act on directly."
        />

        <div className="ops-hero-grid">
          <MetricCard
            label="New in your Inbox"
            value={number(today?.inbox || 0)}
            note={today?.inbox
              ? `${number(today.aeInboxAdmissions)} scored in · ${number(today.humanPromoted)} promoted by you`
              : 'nothing has cleared scoring today yet'}
            tone={today?.inbox ? 'good' : 'neutral'}
          />
          <MetricCard
            label="In your Inbox"
            value={number(jobsInInbox)}
            note="jobs waiting on your decision"
            tone={jobsInInbox > 0 ? 'warn' : 'neutral'}
          />
          <MetricCard
            label="Applied"
            value={number(allTime.applied)}
            note="jobs currently marked applied"
          />
          <MetricCard
            label="Interviewing"
            value={number(allTime.interviewing)}
            note="active conversations"
            tone={allTime.interviewing > 0 ? 'good' : 'neutral'}
          />
        </div>

        <div className="ops-inline-note">
          Since {chicagoDate(allTime.since)}: {compact(allTime.seen)} listings seen
          {' → '}{compact(allTime.ingested)} kept
          {' → '}{number(allTime.enteredInbox)} reached your Inbox
          {' → '}{number(allTime.applied)} applied
          {' → '}{number(allTime.interviewing)} interviewing.
        </div>
      </section>

      {/* ── 2. Attention ─────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="Attention"
          title="Does anything need you"
          note="Faults only: scoring that gave up, a source that stopped producing, a provider incident, or a tripped breaker. Work merely queued or waiting on a scheduled cooldown belongs to the machine and is not listed here."
        />

        {attentionItems.length === 0 ? (
          <div className="ops-empty good">
            Nothing needs you. Every job scored, {number(operations.sourceHealth.length)} sources are producing, no provider incidents are open, and no breaker is tripped.
          </div>
        ) : (
          <div className="ops-attention-list">
            {attentionItems.map((item) => (
              <div
                className={`ops-attention-row${item.onClick ? ' clickable' : ''}`}
                key={item.id}
                onClick={item.onClick}
                role={item.onClick ? 'button' : undefined}
                tabIndex={item.onClick ? 0 : undefined}
                onKeyDown={item.onClick
                  ? (event) => { if (event.key === 'Enter' || event.key === ' ') item.onClick?.(); }
                  : undefined}
              >
                <StatePill value={item.kind} danger={item.severe} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 3. Keeping up ────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="Keeping up"
          title="Is it keeping up"
          note={`Every active employer board is meant to be swept once a week. This measures whether that is actually happening, against a ${percent(coverage.objective * 100)} objective.`}
        />

        <div className="ops-hero-grid">
          <MetricCard
            label="Weekly board coverage"
            value={percent(coverage.coverageRatio * 100)}
            note={`${number(coverage.boardsCheckedWithinCycle)} of ${number(coverage.activeBoards)} active boards swept in the last 7 days`}
            tone={coverage.status === 'healthy' ? 'good' : coverage.status === 'at_risk' ? 'warn' : 'danger'}
          />
          <MetricCard
            label="Longest unswept"
            value={coverage.oldestCheckedAgeDays === null ? 'unknown' : `${number(coverage.oldestCheckedAgeDays)}d`}
            note={coverage.boardsNeverChecked > 0
              ? `${number(coverage.boardsNeverChecked)} active board${coverage.boardsNeverChecked === 1 ? ' has' : 's have'} never been swept`
              : 'every active board has been swept at least once'}
            tone={(coverage.oldestCheckedAgeDays || 0) > coverage.rotationDays ? 'warn' : 'good'}
          />
          <MetricCard
            label="In error recovery"
            value={number(boards.parked + boards.blacklisted)}
            note={`${number(boards.parked)} parked · ${number(boards.blacklisted)} blacklisted · outside the weekly rotation, retried on their own backoff`}
            tone={boards.parked + boards.blacklisted > 0 ? 'warn' : 'good'}
          />
          <MetricCard
            label="Waiting to be scored"
            value={number(scoringBacklog)}
            note={`${number(operations.queues.needsJd)} need a description · ${number(operations.queues.aim)} Aim · ${number(operations.queues.experience)} Experience`}
          />
        </div>

        {coverage.breachReasons.length > 0 && (
          <div className="ops-trust-warning" role="note">
            <strong>Coverage is {coverage.status === 'breached' ? 'breached' : 'at risk'}:</strong>
            <ul className="ops-reason-list">
              {coverage.breachReasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </div>
        )}
      </section>

      <details className="ops-details ops-reference">
        <summary>Lifetime totals and window comparison</summary>
      {/* ── All time ─────────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="All time"
          title="Since you turned this on"
          note={`Lifetime totals across ${number(allTime.runs)} ingestion runs, starting ${chicagoDate(allTime.since)}.`}
        />

        <div className="ops-alltime-grid">
          <div><span>Jobs seen</span><strong>{compact(allTime.seen)}</strong><small>{number(allTime.seen)} raw observations</small></div>
          <div><span>Ingested</span><strong>{compact(allTime.ingested)}</strong><small>{percent(allTime.seen ? (allTime.ingested / allTime.seen) * 100 : null)} of seen</small></div>
          <div><span>Duplicates</span><strong>{compact(allTime.duplicates)}</strong><small>already known</small></div>
          <div><span>Filtered out</span><strong>{compact(allTime.filtered)}</strong><small>failed prefilter</small></div>
          <div className="highlight">
            <span>Reached Inbox</span>
            <strong>{number(allTime.enteredInbox)}</strong>
            <small title={`Inbox admissions are only recorded from ${chicagoDate(allTime.inboxSince)} onward, so this rate uses the ${number(allTime.seenSinceInboxTracking)} jobs seen since then.`}>
              {percent(allTime.inboxRate)} of jobs seen since {chicagoDate(allTime.inboxSince)}
            </small>
          </div>
          <div className="highlight"><span>Applied</span><strong>{number(allTime.applied)}</strong><small>jobs currently marked applied</small></div>
          <div className="highlight"><span>Interviewing</span><strong>{number(allTime.interviewing)}</strong><small>current</small></div>
          <div><span>Provider errors</span><strong>{compact(allTime.providerErrors)}</strong><small>{compact(allTime.processingErrors)} processing errors</small></div>
        </div>

        <div className="ops-window-compare">
          <table className="ops-table">
            <thead><tr><th>Window</th><th>Seen</th><th>Ingested</th><th>Reached Inbox</th><th>Provider errors</th></tr></thead>
            <tbody>
              <tr><td><strong>Today</strong></td><td>{number(today?.seen || 0)}</td><td>{number(today?.ingested || 0)}</td><td>{number(today?.inbox || 0)}</td><td>{number(today?.sourceErrors || 0)}</td></tr>
              <tr><td><strong>7 days</strong></td><td>{number(week.seen)}</td><td>{number(week.ingested)}</td><td>{number(week.enteredInbox)}</td><td>{number(week.providerErrors)}</td></tr>
              <tr><td><strong>30 days</strong></td><td>{number(month.seen)}</td><td>{number(month.ingested)}</td><td>{number(month.enteredInbox)}</td><td>{number(month.providerErrors)}</td></tr>
              <tr className="alltime-row"><td><strong>All time</strong></td><td>{number(allTime.seen)}</td><td>{number(allTime.ingested)}</td><td>{number(allTime.enteredInbox)}</td><td>{number(allTime.providerErrors)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      </details>

      <details className="ops-details ops-reference">
        <summary>Every source, provider incident, and rate-limit budget</summary>
      {/* ── Sources ──────────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="Sources"
          title="What is failing"
          note="Ranked worst first, judged on jobs produced rather than on how a run labelled itself. Failing = nothing produced in 24h, or producing while mostly erroring. Silent = running cleanly and returning nothing. A sweep that hits its turn deadline mid-catalog is normal for the large ATS platforms and is not a fault."
        />

        {failingSources.length === 0 ? (
          <div className="ops-empty good">All {number(operations.sourceHealth.length)} sources ran and inserted normally over the last 7 days.</div>
        ) : (
          <div className="ops-source-list">
            {failingSources.map((source) => <SourceRow key={source.source} source={source} generatedAt={generatedAt} />)}
          </div>
        )}

        {healthySources.length > 0 && (
          <>
            <button className="ops-inline-link" onClick={() => setShowHealthySources((value) => !value)}>
              {showHealthySources ? 'Hide' : 'Show'} {number(healthySources.length)} healthy sources
            </button>
            {showHealthySources && (
              <div className="ops-source-list">
                {healthySources.map((source) => <SourceRow key={source.source} source={source} generatedAt={generatedAt} />)}
              </div>
            )}
          </>
        )}

        {(openIncidents.length > 0 || openCircuits.length > 0) && (
          <div className="ops-two-column">
            <article className="ops-panel">
              <div className="ops-panel-title"><h3>Open provider incidents</h3><span>{openIncidents.length}</span></div>
              {openIncidents.length === 0 ? <div className="ops-empty">None open.</div> : (
                <div className="ops-provider-list">
                  {openIncidents.map((incident) => (
                    <div key={`${incident.provider}:${incident.status}`} className="ops-provider-row">
                      <span>
                        <strong>{incident.provider}</strong>
                        <small>{incident.classifications.join(', ') || 'provider error'} · {number(incident.affectedQueryCount)} queries · {number(incident.occurrenceCount)} occurrences</small>
                        {incident.message && <em title={incident.message}>{incident.message}</em>}
                      </span>
                      <span><StatePill value={incident.status} danger /><small>{describeAge(incident.lastSeenAt)}</small></span>
                    </div>
                  ))}
                </div>
              )}
            </article>

            <article className="ops-panel">
              <div className="ops-panel-title"><h3>Rate limits &amp; budgets</h3><span>{openCircuits.length} constrained</span></div>
              {operations.circuits.length === 0 ? <div className="ops-empty">No circuit state recorded.</div> : (
                <div className="ops-provider-list">
                  {operations.circuits.map((circuit) => (
                    <div key={circuit.provider} className="ops-provider-row">
                      <span>
                        <strong>{circuit.provider}</strong>
                        <small>
                          Day: {number(circuit.dailyUsed)}{circuit.dailyLimit == null ? '' : ` / ${number(circuit.dailyLimit)}`}
                          {' · '}Month: {number(circuit.monthlyUsed)}{circuit.monthlyLimit == null ? '' : ` / ${number(circuit.monthlyLimit)}`}
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
        )}
      </section>
      </details>

      <details className="ops-details ops-reference">
        <summary>Employer board detail, by platform and by lifecycle stage</summary>
      {/* ── ATS coverage ─────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="ATS coverage"
          title="Employer board API endpoints"
          note="The employer board catalog and today's acquisition work. Live progress against the rotation lives on the Log tab; this is the standing shape of the catalog. Parked and blacklisted boards sit outside the weekly rotation and are retried on their own backoff — blacklisted means a 30-day recheck, not removal."
        />

        {!atsPath.available && (
          <div className="ops-trust-warning" role="note">
            Split-path ATS receipts are not available yet. Endpoint coverage below is limited to the legacy completed-check timestamp.
          </div>
        )}

        {atsPath.available && !atsPath.enabled && (
          <div className="ops-trust-warning" role="note">
            Split-path ATS acquisition is disabled. The receipt history remains visible while the legacy acquisition path is active.
          </div>
        )}

        {/*
          Tiles that read a source nothing writes have been removed rather than
          repaired. Responded, Synchronized, Processed, Legacy claims and Empty
          deferrals all queried the retired per-board attempt log, whose last
          row was written 2026-08-31; Jobs remaining, Backpressure gate,
          Processed-last-hour, Prequeue dupes and Oldest synchronized summed a
          batch job counter the v2 writer leaves at zero, or filtered on batch
          states it never produces. Each showed a confident zero forever, which
          is worse than showing nothing.
        */}
        <div className="ops-ats-summary">
          <div className="total"><span>Active boards</span><strong>{number(boards.active)}</strong><small>in the weekly rotation, across {number(boards.byPlatform.length)} ATS platforms</small></div>
          <div><span>Retired</span><strong>{number(Math.max(0, boards.total - boards.active - boards.parked - boards.blacklisted))}</strong><small>excluded by an operator or an exclusion rule; not swept</small></div>
          <div><span>Parked</span><strong>{number(boards.parked)}</strong><small>one or two failures; retried on their own backoff</small></div>
          <div><span>Blacklisted</span><strong>{number(boards.blacklisted)}</strong><small>three or more failures; rechecked after 30 days</small></div>
          <div><span>Boards contacted today</span><strong>{number(atsPath.newCycleListingContactedToday)}</strong><small>{number(atsPath.dailyTarget)} needed a day to finish a weekly pass</small></div>
          <div><span>Continuation calls today</span><strong>{number(atsPath.listingContinuationContactedToday)}</strong><small>resumed paging on a board already started; not new boards</small></div>
          <div><span>Listing work in flight</span><strong>{number(atsAcquisitionBacklog)}</strong><small>boards part-way through their listing or detail fetch</small></div>
          <div><span>Payloads awaiting processing</span><strong>{number(atsProcessingBacklog)}</strong><small>downloaded and waiting to be turned into jobs</small></div>
          <div><span>Worker lanes</span><strong>{number(atsPath.activePiSlots + atsPath.activeMacSlots)}/{number(atsPath.globalSlotLimit)}</strong><small>{atsPath.remoteWorkersEnabled ? 'leased right now' : 'remote workers disabled'}</small></div>
          <div><span>Admission mode</span><strong>{atsPath.admissionState}</strong><small>{atsPath.admissionState === 'open' ? 'new boards are being claimed' : 'draining pauses new boards only'}</small></div>
          <div><span>Retained failures</span><strong>{number(atsPath.queue.failed)}</strong><small>failed payloads kept for diagnosis, not retried automatically</small></div>
        </div>

        <BoardReviewPanel />

        <article className="ops-panel ops-table-panel">
          <div className="ops-panel-title"><h3>By platform</h3><span>{number(boards.active)} active boards</span></div>
          <div className="ops-table-scroll">
            <table className="ops-table">
              <thead><tr><th>Platform</th><th>Active</th><th>Parked</th><th>Blacklisted</th><th>Retired</th><th>Share of rotation</th></tr></thead>
              <tbody>
                {boards.byPlatform.map((platform) => (
                  <tr key={platform.name}>
                    <td><strong>{platform.name}</strong></td>
                    <td className="good-cell">{number(platform.active)}</td>
                    <td>{number(platform.parked)}</td>
                    <td className={platform.blacklisted ? 'danger-cell' : ''}>{number(platform.blacklisted)}</td>
                    <td>{number(Math.max(0, platform.total - platform.active - platform.parked - platform.blacklisted))}</td>
                    {/* Share of the boards actually swept. Sharing on the raw
                        total let teamtailor read as 4.7% of the catalog on one
                        active board. */}
                    <td>{percent(boards.active ? (platform.active / boards.active) * 100 : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>
      </details>

      <details className="ops-details ops-reference">
        <summary>Where jobs drop out, and the daily breakdown</summary>
      {/* ── Funnel ───────────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="Funnel"
          title="Where jobs drop out"
          note="Each stage uses its own timestamps, so these are stage throughput over the window — not one cohort followed end to end."
        />

        {week.unreconciledRuns > 0 && (
          <div className="ops-trust-warning" role="note">
            {number(week.unreconciledRuns)} source runs in the last 7 days do not reconcile. Their counts are shown but not trusted.
          </div>
        )}

        <div className="ops-funnel" aria-label="Seven-day job funnel">
          <FunnelStage label="Seen" value={week.seen} sub="source observations" />
          <i aria-hidden>→</i>
          <FunnelStage label="Ingested" value={week.ingested} sub={`${percent(week.seen ? (week.ingested / week.seen) * 100 : null)} of seen`} />
          <i aria-hidden>→</i>
          <FunnelStage label="Passed local filter" value={week.localPassed} sub={percent(week.localStageThroughputRatio)} unavailable={outcomes.stageCoverage.local} />
          <i aria-hidden>→</i>
          <FunnelStage label="Passed Aim & Experience" value={week.aePassed} sub={`${percent(week.aePassRate)} of evaluated`} unavailable={outcomes.stageCoverage.ae} />
          <i aria-hidden>→</i>
          <FunnelStage label="Reached Inbox" value={week.enteredInbox} sub={`${percent(week.inboxStageThroughputRatio)} of seen`} highlight />
        </div>

        <details className="ops-details">
          <summary>Daily breakdown · last 30 days</summary>
          <div className="ops-table-scroll daily-table-scroll">
            <table className="ops-table ops-daily-table">
              <thead>
                <tr>
                  <th>Date</th><th>Seen</th><th>New</th><th>Duplicate</th><th>Filtered</th><th>Processing</th><th>Provider</th><th>Passed Aim &amp; Experience</th><th>Reached Inbox</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.daily.map((day) => (
                  <tr key={day.date} className={!day.ingestionReconciles && day.runCount > 0 ? 'danger-row' : ''}>
                    <td>
                      <strong>{new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })}</strong>
                      <small>{day.transitionTrackingStatus !== 'tracked' ? `${day.transitionTrackingStatus} events` : day.ingestionReconciles ? 'reconciled' : 'review totals'}</small>
                    </td>
                    <td>{number(day.seen)}</td>
                    <td className="good-cell">{number(day.ingested)}</td>
                    <td>{number(day.duplicates)}</td>
                    <td>{number(day.ingestionFiltered)}</td>
                    <td className={day.processingErrors ? 'danger-cell' : ''}>{number(day.processingErrors)}</td>
                    <td className={day.sourceErrors ? 'danger-cell' : ''}>{number(day.sourceErrors)}</td>
                    <td>{number(day.passedAE)}<small>{number(day.rejectedAE)} rejected</small></td>
                    <td className="good-cell">
                      <strong>{number(day.inbox)}</strong>
                      <small>{number(day.aeInboxAdmissions)} scored in · {number(day.humanPromoted)} promoted by you</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small className="ops-table-disclosure">
            Event tracking since {chicagoDateTime(stats.asOf.eventTrackingSince)} · ingestion tracking since {chicagoDateTime(stats.asOf.ingestionTrackingSince)}
          </small>
        </details>
      </section>
      </details>

      <details className="ops-details ops-reference">
        <summary>Scoring quality and prompt versions</summary>
      {/* ── Scoring ──────────────────────────────────────────────── */}
      <section className="ops-section">
        <SectionHeading
          eyebrow="Scoring"
          title="Is scoring finding the right work?"
          note={`Latest non-stale evaluation per job under the active scoring version. ${number(calibration.population.aim)} Aim and ${number(calibration.population.experience)} Experience evaluations currently qualify.`}
        />

        <div className="ops-hero-grid">
          <MetricCard
            label="Average Aim fit"
            value={<Metric metric={inventory.averages.aimFit} />}
            note={`${number(calibration.population.aim)} evaluations`}
          />
          <MetricCard
            label="Average Experience fit"
            value={<Metric metric={inventory.averages.experienceFit} />}
            note={`${number(calibration.population.experience)} evaluations`}
          />
          <MetricCard
            label="Waiting to be scored"
            value={number(scoringBacklog)}
            note={`${number(operations.queues.needsJd)} need a description · ${number(operations.queues.aim)} Aim · ${number(operations.queues.experience)} Experience`}
            tone={operations.queues.aim > 0 ? 'warn' : 'neutral'}
          />
        </div>

        <div className="calibration-columns">
          <article className="ops-panel ops-table-panel">
            <div className="ops-panel-title"><h3>Prompt versions</h3><span>latest evaluation per job</span></div>
            {calibration.promptCohorts.length === 0 ? <div className="ops-empty">No evaluations match the active scoring version.</div> : (
              <div className="ops-table-scroll">
                <table className="ops-table">
                  <thead><tr><th>Stage / prompt</th><th>Evaluated</th><th>Passed</th><th>Pass rate</th><th>Avg Aim / Experience</th><th>Latest</th></tr></thead>
                  <tbody>
                    {calibration.promptCohorts.map((cohort) => {
                      /*
                       * A stage that produced no score and passed nothing is not
                       * a gate -- it is an intermediate step of the same
                       * pipeline. Printing 0% beside a holistic stage's 100%
                       * invited reading a working stage as a broken one.
                       */
                      const gates = cohort.passed > 0
                        || cohort.averageAim !== null
                        || cohort.averageExperience !== null;
                      return (
                        <tr key={`${cohort.evaluationType}:${cohort.promptVersion}`}>
                          <td><strong>{cohort.promptVersion}</strong><small>{cohort.evaluationType.replaceAll('_', ' ')}</small></td>
                          <td>{number(cohort.evaluated)}</td>
                          <td>{gates ? number(cohort.passed) : '—'}</td>
                          <td>{gates ? percent(cohort.passRate) : <small>does not gate</small>}</td>
                          <td>{cohort.averageAim || '—'} / {cohort.averageExperience || '—'}</td>
                          <td>{describeAge(cohort.lastEvaluatedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </div>
      </section>
      </details>

      {/* ── Internals ────────────────────────────────────────────── */}
      <details className="ops-details">
        <summary>Pipeline &amp; scheduler internals</summary>

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
              <h3>Manual scoring exchange</h3>
              <StatePill value={operations.scoringBatch?.status || 'idle'} danger={operations.scoringBatch?.status === 'superseded'} />
            </div>
            <strong>{operations.scoringBatch ? `${operations.scoringBatch.stage.replaceAll('_', ' ')} batch` : 'No exported batch'}</strong>
            <p>{operations.scoringBatch ? `${number(operations.scoringBatch.imported)} of ${number(operations.scoringBatch.total)} imported` : 'Scoring waits for a manual export.'}</p>
            <dl className="ops-mini-dl">
              <div><dt>Created</dt><dd>{describeAge(operations.scoringBatch?.createdAt || null)}</dd></div>
              <div><dt>Expires</dt><dd>{operations.scoringBatch ? chicagoDateTime(operations.scoringBatch.expiresAt) : 'none'}</dd></div>
            </dl>
          </article>

          <article className="ops-panel ops-queue-panel">
            <div className="ops-panel-title"><h3>Scoring queues</h3></div>
            <dl className="ops-queue-grid">
              <div><dt>Local</dt><dd>{number(operations.queues.local)}</dd></div>
              <div><dt>Needs JD</dt><dd>{number(operations.queues.needsJd)}</dd></div>
              <div><dt>Aim</dt><dd>{number(operations.queues.aim)}</dd></div>
              <div><dt>Experience</dt><dd>{number(operations.queues.experience)}</dd></div>
              <div><dt>Context</dt><dd>{number(operations.queues.context)}</dd></div>
              <div className={operations.queues.actionNeeded ? 'danger' : ''}><dt>Action needed</dt><dd>{number(operations.queues.actionNeeded)}</dd></div>
            </dl>
            <button className="ops-inline-link" onClick={onOpenActionNeeded}>Open Action Needed queue →</button>
          </article>
        </div>

        <article className="ops-panel ops-table-panel">
          <div className="ops-panel-title">
            <h3>Running now</h3>
            <span>{number(summary.running)} active · {number(summary.staleLeases)} stale leases</span>
          </div>
          <TaskTable tasks={runningTasks} total={summary.running + summary.staleLeases} generatedAt={generatedAt} empty="No search tasks are running." />
        </article>

        <article className="ops-panel ops-table-panel">
          <div className="ops-panel-title">
            <h3>Runnable backlog</h3>
            <span>Oldest eligible {summary.oldestRunnableSince ? describeAge(summary.oldestRunnableSince) : 'none'}</span>
          </div>
          <TaskTable tasks={runnableTasks} total={summary.runnableNow} generatedAt={generatedAt} empty="No active search tasks are runnable right now." />
        </article>

        <article className="ops-panel ops-table-panel">
          <div className="ops-panel-title">
            <h3>Blocked &amp; retrying</h3>
            <span>{number(summary.circuitCooldown)} circuit · {number(summary.blockedBudget)} budget · {number(summary.failedAwaitingRetry)} failed</span>
          </div>
          <TaskTable tasks={blockedTasks} total={summary.circuitCooldown + summary.blockedBudget + summary.failedAwaitingRetry} generatedAt={generatedAt} empty="Nothing is blocked." />
        </article>

        <article className="ops-panel ops-table-panel">
          <div className="ops-panel-title">
            <h3>Recent checkpoints</h3>
            <span>
              Next runnable {summary.nextRunnableAt ? chicagoDateTime(summary.nextRunnableAt) : 'not scheduled'}
              {' · '}watermark {summary.latestWatermarkAt ? chicagoDateTime(summary.latestWatermarkAt) : 'not established'}
            </span>
          </div>
          <TaskTable tasks={recentCheckpoints} total={summary.scheduled + summary.failedAwaitingRetry} generatedAt={generatedAt} empty="No completed checkpoints recorded." />
          <button className="ops-inline-link" onClick={() => setShowRetiredTasks((value) => !value)}>
            {showRetiredTasks ? 'Hide' : 'Show'} {number(summary.retired)} retired and {number(summary.orchestration)} orchestration tasks
          </button>
          {showRetiredTasks && <TaskTable tasks={retiredTasks} total={summary.retired + summary.orchestration} generatedAt={generatedAt} empty="No retired or orchestration tasks." />}
        </article>
      </details>

      {/* ── Inventory ────────────────────────────────────────────── */}
      <details className="ops-details">
        <summary>Job inventory · {number(inventory.totalJobs)} rows</summary>
        <div className="ops-inventory-grid">
          <article className="ops-panel">
            <div className="ops-panel-title"><h3>By status</h3><strong>{number(inventory.totalJobs)}</strong></div>
            <div className="ops-compact-list">
              {[...inventory.jobsByStatus].sort((a, b) => b.count - a.count).map((status) => (
                <div key={status.name}><span>{status.name.replaceAll('_', ' ')}</span><strong>{number(status.count)}</strong></div>
              ))}
            </div>
          </article>
          <article className="ops-panel">
            <div className="ops-panel-title"><h3>Top sources</h3></div>
            <div className="ops-compact-list">
              {[...inventory.jobsBySource].sort((a, b) => b.count - a.count).slice(0, 12).map((source) => (
                <div key={source.name}><span>{source.name}</span><strong>{number(source.count)}</strong></div>
              ))}
            </div>
          </article>
        </div>
      </details>

      <details className="ops-details">
        <summary>ATS catalog discovery</summary>
        <div className="ops-discovery-head">
          <p>Expands the employer-board catalog by crawling Common Crawl for new tenant URLs. This is not the recurring job ingestion scheduler.</p>
          <div>
            {isDiscoveryRunning && (
              <button className="btn btn-danger" onClick={() => changeDiscovery('stop')} disabled={discoveryAction !== null}>
                {discoveryAction === 'stop' ? 'Stopping…' : 'Stop discovery'}
              </button>
            )}
            <button className="btn btn-primary" onClick={() => changeDiscovery('start')} disabled={isDiscoveryRunning || discoveryAction !== null}>
              {isDiscoveryRunning || discoveryAction === 'start' ? <Loader className="spin" size={16} /> : <Play size={16} />}
              {discoveryAction === 'start' ? 'Starting…' : isDiscoveryRunning ? 'Running…' : 'Run discovery'}
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
