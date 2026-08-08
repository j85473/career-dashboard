'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Loader, Play } from 'lucide-react';
import { showAlert } from '@/lib/modal';

interface StatsData {
  totalJobs: number;
  jobsByStatus: Array<{ name: string; count: number }>;
  jobsBySource: Array<{ name: string; count: number }>;
  averages?: { aimFit?: number; experienceFit?: number };
  atsBoards: {
    total: number;
    active: number;
    parked: number;
    byPlatform: Array<{ name: string; active: number; parked: number }>;
  };
  recentIngestionRuns?: Array<{
    id: string;
    source: string;
    status: string;
    seenCount: number;
    insertedCount: number;
    duplicateCount: number;
    filteredCount: number;
    errorCount: number;
    error?: string | null;
    finishedAt?: string | null;
    durationMs?: number | null;
  }>;
  sourceHealth?: Array<{
    source: string;
    lastSuccessAt: string | null;
    lastRunAt: string | null;
    failedRuns: number;
    idleRuns: number;
    totalRuns: number;
    insertedCount: number;
  }>;
  activityTrackingSince?: string | null;
  dailyActivity?: Array<{
    date: string;
    seen: number;
    ingested: number;
    duplicates: number;
    ingestionFiltered: number;
    processingErrors: number;
    sourceErrors: number;
    ingestionReconciles: boolean;
    localRejected: number;
    rejectedAE: number;
    passedAE: number;
    inbox: number;
    transitionTrackingStatus: 'untracked' | 'partial' | 'tracked';
  }>;
}

/** "never succeeded" is the signal that matters most, so it is stated plainly. */
function describeLastSuccess(lastSuccessAt: string | null): string {
  if (!lastSuccessAt) return 'no success in 7d';
  const hours = Math.floor((Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000);
  if (hours < 1) return 'ok just now';
  if (hours < 24) return `ok ${hours}h ago`;
  return `ok ${Math.floor(hours / 24)}d ago`;
}

function ActivityMetric({ label, value, color, note }: {
  label: string;
  value: number;
  color?: string;
  note?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <h4 style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px 0', lineHeight: 1.35 }}>
        {label}
      </h4>
      <div style={{ fontSize: '20px', fontWeight: 600, color }}>{value.toLocaleString()}</div>
      {note && <small style={{ color: 'var(--muted)', fontSize: '10px', lineHeight: 1.3 }}>{note}</small>}
    </div>
  );
}

export function StatsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsError, setStatsError] = useState('');
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const terminalRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const readJson = async (path: string) => {
      const res = await fetch(path, { signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to load ${path}.`);
      return data;
    };

    Promise.all([
      readJson('/api/stats'),
    ])
      .then(([data]) => {
        if (!data?.atsBoards || !Array.isArray(data.jobsByStatus) || !Array.isArray(data.jobsBySource)) {
          throw new Error('The stats response was incomplete.');
        }
        setStats(data);
        setLoading(false);
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatsError(err instanceof Error ? err.message : 'Failed to load database stats.');
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  // Poll background process status
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/ats-companies/discover');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setIsRunning(data.isRunning);
          if (data.logs && data.logs.length > 0) {
            const nextLogs = data.logs.map((line: string) => line + '\n');
            if (!cancelled) setTerminalOutput((previous) => JSON.stringify(previous) === JSON.stringify(nextLogs) ? previous : nextLogs);
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) timeout = setTimeout(fetchStatus, isRunning ? 3000 : 10000);
      }
    };
    fetchStatus();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [isRunning]);

  const handleRunDiscovery = async () => {
    try {
      const res = await fetch('/api/ats-companies/discover', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to start discovery.');
      setIsRunning(true);
    } catch (err) {
      await showAlert("Failed to start discovery: " + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleStopDiscovery = async () => {
    try {
      const res = await fetch('/api/ats-companies/discover', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to stop discovery.');
      setIsRunning(false);
    } catch (err) {
      await showAlert("Failed to stop discovery: " + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>Loading Database Stats...</div>;
  }

  if (!stats) {
    return <div className="inline-error" role="alert">{statsError || 'Failed to load stats.'}</div>;
  }

  const seenSources = new Set<string>();
  const latestSourceRuns = (stats.recentIngestionRuns || []).filter((run) => {
    if (seenSources.has(run.source)) return false;
    seenSources.add(run.source);
    return true;
  });
  const activityTrackingLabel = stats.activityTrackingSince
    ? new Date(stats.activityTrackingSince).toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    : null;

  return (
    <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto', color: 'var(--text)' }}>
      <h2 style={{ marginBottom: '1.5rem', fontWeight: 600 }}>Database Overview</h2>
      
      <div className="stats-grid">
        
        {/* ATS Boards Stats */}
        <div style={{ background: 'var(--surface)', padding: '1rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', color: 'var(--accent)' }}>
            ATS Discovery Engine
          </h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span>Total Endpoints</span>
            <strong>{stats.atsBoards.total.toLocaleString()}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', color: '#10b981' }}>
            <span>Active & Verified</span>
            <strong>{stats.atsBoards.active.toLocaleString()}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem', color: 'var(--muted)' }}>
            <span>Parked (Cooldown)</span>
            <strong>{stats.atsBoards.parked.toLocaleString()}</strong>
          </div>
          
          <h4 style={{ fontSize: '13px', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: '0.5rem' }}>Breakdown by Platform</h4>
          {stats.atsBoards.byPlatform.map((p) => (
            <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '14px', alignItems: 'center' }}>
              <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>{p.name}</span>
              <div style={{ textAlign: 'right', fontSize: '12px' }}>
                <span style={{ color: '#10b981', marginRight: '8px' }}>{p.active.toLocaleString()} Active</span>
                <span style={{ color: 'var(--muted)' }}>{p.parked.toLocaleString()} Parked</span>
              </div>
            </div>
          ))}
        </div>

        {/* Jobs Stats */}
        <div style={{ background: 'var(--surface)', padding: '1rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', color: 'var(--accent)' }}>
            Job Database
          </h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span>Total Jobs Scraped</span>
            <strong>{stats.totalJobs.toLocaleString()}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', color: 'var(--accent)' }}>
            <span>Average Aim Fit Score</span>
            <strong>{stats.averages?.aimFit || 0}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem', color: 'var(--accent)' }}>
            <span>Average Experience Fit Score</span>
            <strong>{stats.averages?.experienceFit || 0}</strong>
          </div>

          <h4 style={{ fontSize: '13px', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: '0.5rem' }}>Current Pipeline</h4>
          {stats.jobsByStatus.map((s) => (
            <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '14px' }}>
              <span style={{ textTransform: 'capitalize' }}>{s.name}</span>
              <strong>{s.count.toLocaleString()}</strong>
            </div>
          ))}

          <h4 style={{ fontSize: '13px', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: '0.5rem', marginTop: '1.5rem' }}>Top Sources</h4>
          {[...stats.jobsBySource].sort((a, b) => b.count - a.count).map((s) => (
            <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '14px' }}>
              <span>{s.name}</span>
              <strong>{s.count.toLocaleString()}</strong>
            </div>
          ))}
        </div>

        <div style={{ background: 'var(--surface)', padding: '1rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', color: 'var(--accent)' }}>
            Recent Source Health
          </h3>
          {latestSourceRuns.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '13px' }}>Source telemetry will appear after the next ingestion run.</p>
          ) : latestSourceRuns.map((run) => {
            const health = (stats.sourceHealth || []).find((entry) => entry.source === run.source);
            return (
              <div className="source-health-row" key={run.id} title={run.error || undefined}>
                <span>
                  <strong>{run.source}</strong>
                  <small>
                    {health
                      // The week's totals are what expose a source that has been
                      // quietly returning nothing; the latest run alone cannot.
                      ? `${health.insertedCount} new in 7d · ${describeLastSuccess(health.lastSuccessAt)}${health.failedRuns ? ` · ${health.failedRuns} failed` : ''}`
                      : `${run.insertedCount} new · ${run.duplicateCount} duplicate · ${run.filteredCount} filtered`}
                  </small>
                </span>
                <strong className={`source-health-status ${run.status}`}>{run.status}</strong>
              </div>
            );
          })}
        </div>
      </div>

      {stats.dailyActivity && stats.dailyActivity.length > 0 && (
        <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border)', marginBottom: '1.5rem' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', color: 'var(--accent)' }}>
            Daily Activity Stats (30 Calendar Days)
          </h3>
          <p style={{ color: 'var(--muted)', fontSize: '12px', lineHeight: 1.5, margin: '-0.25rem 0 1rem' }}>
            Seen reconciles to new + duplicate + title/location filtered + processing errors. Source errors are request-level failures outside the seen-job denominator.
            {activityTrackingLabel && ` Local-scoring and inbox transitions are forward-only from ${activityTrackingLabel}; A/E decisions use their complete score-event history.`}
          </p>
          
          <div style={{ maxHeight: '350px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', paddingRight: '0.5rem' }}>
            {stats.dailyActivity.map((day, i) => {
              const trackingNote = day.transitionTrackingStatus === 'untracked'
                ? 'not tracked yet'
                : day.transitionTrackingStatus === 'partial'
                  ? 'partial day'
                  : undefined;
              return (
              <div key={day.date} style={{ paddingBottom: '1rem', borderBottom: i < stats.dailyActivity!.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <h4 style={{ marginBottom: '1rem', marginTop: 0, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  {!day.ingestionReconciles && (
                    <small style={{ color: 'var(--red)', fontWeight: 500 }}>ingestion totals need review</small>
                  )}
                </h4>
                <div style={{ marginBottom: '0.9rem' }}>
                  <div style={{ fontSize: '10px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.55rem' }}>Ingestion</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '1rem' }}>
                    <ActivityMetric label="Seen" value={day.seen} />
                    <ActivityMetric label="New" value={day.ingested} color="#10b981" />
                    <ActivityMetric label="Duplicate" value={day.duplicates} />
                    <ActivityMetric label="Title/location filtered" value={day.ingestionFiltered} color="var(--red)" />
                    <ActivityMetric label="Processing errors" value={day.processingErrors} color="var(--red)" />
                    <ActivityMetric label="Source errors" value={day.sourceErrors} color="var(--red)" note="outside seen" />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '10px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.55rem' }}>Scoring and movement</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '1rem' }}>
                    <ActivityMetric label="Local scoring rejected" value={day.localRejected} color="var(--red)" note={trackingNote} />
                    <ActivityMetric label="A/E rejected" value={day.rejectedAE} color="var(--red)" />
                    <ActivityMetric label="A/E passed" value={day.passedAE} color="#10b981" />
                    <ActivityMetric label="Entered inbox" value={day.inbox} color="var(--accent)" note={trackingNote} />
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ color: 'var(--accent)', margin: 0 }}>ATS Discovery Engine Runner</h3>
          <div style={{ display: 'flex', gap: '12px' }}>
            {isRunning && (
              <button 
                className="btn btn-secondary" 
                onClick={handleStopDiscovery} 
                style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--red)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
              >
                Stop Discovery
              </button>
            )}
            <button 
              className="btn btn-primary" 
              onClick={handleRunDiscovery} 
              disabled={isRunning}
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              {isRunning ? <Loader className="spin" size={16} /> : <Play size={16} />}
              {isRunning ? 'Running Discovery...' : 'Run Discovery Process'}
            </button>
          </div>
        </div>
        
        <pre 
          ref={terminalRef}
          style={{ 
            background: '#0d1117', 
            color: '#c9d1d9', 
            padding: '1rem', 
            borderRadius: '8px', 
            height: '300px', 
            overflowY: 'auto',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
            border: '1px solid #30363d'
          }}
        >
          {terminalOutput.length === 0 ? <span style={{ color: '#8b949e' }}>Ready. Click &quot;Run Discovery Process&quot; to start tailing Common Crawl...</span> : terminalOutput.join('')}
        </pre>
      </div>

    </div>
  );
}
