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
  dailyActivity?: Array<{
    date: string;
    ingested: number;
    killedLocal: number;
    killedAE: number;
    passedAE: number;
    inbox: number;
    lucky: number;
  }>;
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
  }).slice(0, 12);

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
          ) : latestSourceRuns.map((run) => (
            <div className="source-health-row" key={run.id} title={run.error || undefined}>
              <span>
                <strong>{run.source}</strong>
                <small>{run.insertedCount} new · {run.duplicateCount} duplicate · {run.filteredCount} filtered</small>
              </span>
              <strong className={`source-health-status ${run.status}`}>{run.status}</strong>
            </div>
          ))}
        </div>
      </div>

      {stats.dailyActivity && stats.dailyActivity.length > 0 && (
        <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border)', marginBottom: '1.5rem' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', color: 'var(--accent)' }}>
            Daily Activity Stats (Last 30 Days)
          </h3>
          
          <div style={{ maxHeight: '350px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', paddingRight: '0.5rem' }}>
            {stats.dailyActivity.map((day, i) => (
              <div key={day.date} style={{ paddingBottom: '1rem', borderBottom: i < stats.dailyActivity!.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <h4 style={{ marginBottom: '1rem', marginTop: 0, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                </h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px 0' }}>Jobs Ingested</h4>
                    <div style={{ fontSize: '20px', fontWeight: 600 }}>{day.ingested.toLocaleString()}</div>
                  </div>
                  <div>
                    <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px 0' }}>Killed (Local)</h4>
                    <div style={{ fontSize: '20px', fontWeight: 600, color: 'var(--red)' }}>{day.killedLocal.toLocaleString()}</div>
                  </div>
                  <div>
                    <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px 0' }}>Killed (A/E)</h4>
                    <div style={{ fontSize: '20px', fontWeight: 600, color: 'var(--red)' }}>{day.killedAE.toLocaleString()}</div>
                  </div>
                  <div>
                    <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px 0' }}>Passed (A/E)</h4>
                    <div style={{ fontSize: '20px', fontWeight: 600, color: '#10b981' }}>{day.passedAE.toLocaleString()}</div>
                  </div>
                  <div>
                    <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px 0' }}>Made it to Inbox</h4>
                    <div style={{ fontSize: '20px', fontWeight: 600, color: 'var(--accent)' }}>{day.inbox.toLocaleString()}</div>
                  </div>
                  <div>
                    <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 4px 0' }}>I&apos;m Feeling Lucky</h4>
                    <div style={{ fontSize: '20px', fontWeight: 600, color: '#f59e0b' }}>{day.lucky.toLocaleString()}</div>
                  </div>
                </div>
              </div>
            ))}
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
