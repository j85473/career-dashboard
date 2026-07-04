'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Loader, Play } from 'lucide-react';

export function StatsTab() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const terminalRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    fetch('/api/stats')
      .then(res => res.json())
      .then(data => {
        setStats(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  // Poll background process status
  useEffect(() => {
    let interval: any;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/ats-companies/discover');
        if (res.ok) {
          const data = await res.json();
          setIsRunning(data.isRunning);
          if (data.logs && data.logs.length > 0) {
            setTerminalOutput(data.logs.map((l: string) => l + '\n'));
          }
        }
      } catch (e) {
        console.error(e);
      }
    };
    
    // Initial fetch
    fetchStatus();
    
    // Poll every 3 seconds
    interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleRunDiscovery = async () => {
    try {
      await fetch('/api/ats-companies/discover', { method: 'POST' });
      // Next poll will update the UI to show running state
    } catch (err: any) {
      alert("Failed to start discovery: " + err.message);
    }
  };

  const handleStopDiscovery = async () => {
    try {
      await fetch('/api/ats-companies/discover', { method: 'DELETE' });
      setIsRunning(false);
    } catch (err: any) {
      alert("Failed to stop discovery: " + err.message);
    }
  };

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>Loading Database Stats...</div>;
  }

  if (!stats) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--accent)' }}>Failed to load stats.</div>;
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', color: 'var(--text)' }}>
      <h2 style={{ marginBottom: '1.5rem', fontWeight: 600 }}>Database Overview</h2>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginBottom: '2rem' }}>
        
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
          {stats.atsBoards.byPlatform.map((p: any) => (
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
          {stats.jobsByStatus.map((s: any) => (
            <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '14px' }}>
              <span style={{ textTransform: 'capitalize' }}>{s.name}</span>
              <strong>{s.count.toLocaleString()}</strong>
            </div>
          ))}

          <h4 style={{ fontSize: '13px', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: '0.5rem', marginTop: '1.5rem' }}>Top Sources</h4>
          {stats.jobsBySource.sort((a: any, b: any) => b.count - a.count).map((s: any) => (
            <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '14px' }}>
              <span>{s.name}</span>
              <strong>{s.count.toLocaleString()}</strong>
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
          {terminalOutput.length === 0 ? <span style={{ color: '#8b949e' }}>Ready. Click "Run Discovery Process" to start tailing Common Crawl...</span> : terminalOutput.join('')}
        </pre>
      </div>

    </div>
  );
}
