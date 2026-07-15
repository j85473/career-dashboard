'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Loader, Play } from 'lucide-react';

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
  contextHistory?: {
    revisionCount: number;
    latestRevision?: {
      createdAt: string;
      model: string;
      promptVersion: string;
      sourceJobIds: string[];
    } | null;
  };
}

interface UsageData {
  deepseek?: {
    attempts: number;
    succeeded: number;
    failed: number;
    inputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    estimatedCost: number;
    averageLatencyMs: number;
  };
}

export function StatsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
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
      readJson('/api/usage').catch(() => null),
    ])
      .then(([data, usageData]) => {
        if (!data?.atsBoards || !Array.isArray(data.jobsByStatus) || !Array.isArray(data.jobsBySource)) {
          throw new Error('The stats response was incomplete.');
        }
        setStats(data);
        setUsage(usageData);
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
      alert("Failed to start discovery: " + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleStopDiscovery = async () => {
    try {
      const res = await fetch('/api/ats-companies/discover', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to stop discovery.');
      setIsRunning(false);
    } catch (err) {
      alert("Failed to stop discovery: " + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>Loading Database Stats...</div>;
  }

  if (!stats) {
    return <div className="inline-error" role="alert">{statsError || 'Failed to load stats.'}</div>;
  }

  const deepseek = usage?.deepseek;
  const cacheRate = deepseek && deepseek.inputTokens > 0
    ? Math.round((deepseek.cacheHitTokens / deepseek.inputTokens) * 100)
    : 0;
  const seenSources = new Set<string>();
  const latestSourceRuns = (stats.recentIngestionRuns || []).filter((run) => {
    if (seenSources.has(run.source)) return false;
    seenSources.add(run.source);
    return true;
  }).slice(0, 12);

  return (
    <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', color: 'var(--text)' }}>
      <h2 style={{ marginBottom: '1.5rem', fontWeight: 600 }}>Database Overview</h2>
      
      <div className="stats-grid">
        
        {/* ATS Boards Stats */}
        <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
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
        <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
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
      </div>

      <div className="stats-grid">
        <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem', color: 'var(--accent)' }}>
            DeepSeek Today
          </h3>
          {deepseek ? (
            <>
              <div className="stats-row"><span>Successful API attempts</span><strong>{deepseek.succeeded}</strong></div>
              <div className="stats-row"><span>Failed API attempts</span><strong>{deepseek.failed}</strong></div>
              <div className="stats-row"><span>Total tokens</span><strong>{deepseek.totalTokens.toLocaleString()}</strong></div>
              <div className="stats-row"><span>Prompt cache reuse</span><strong>{cacheRate}%</strong></div>
              <div className="stats-row"><span>Estimated cost</span><strong>${deepseek.estimatedCost.toFixed(4)}</strong></div>
              <div className="stats-row"><span>Average latency</span><strong>{(deepseek.averageLatencyMs / 1000).toFixed(1)}s</strong></div>
            </>
          ) : (
            <p style={{ color: 'var(--muted)', fontSize: '13px' }}>Usage telemetry will appear after the database migration and the next scoring run.</p>
          )}
          <h4 style={{ fontSize: '13px', textTransform: 'uppercase', color: 'var(--muted)', margin: '1.5rem 0 0.5rem' }}>Context feedback history</h4>
          <div className="stats-row"><span>Recorded rule revisions</span><strong>{stats.contextHistory?.revisionCount || 0}</strong></div>
          <div className="stats-row">
            <span>Last revision</span>
            <strong>{stats.contextHistory?.latestRevision ? new Date(stats.contextHistory.latestRevision.createdAt).toLocaleDateString() : 'None'}</strong>
          </div>
        </div>

        <div style={{ background: 'var(--surface)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border)' }}>
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
