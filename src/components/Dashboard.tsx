'use client';

import React, { useState, useEffect, useRef } from 'react';
import JobCard from './JobCard';
import { LinkedInTab } from './LinkedInTab';
import { ExpandOverlay } from './ExpandOverlay';
import { ScoringLogTab } from './ScoringLogTab';
import { StatsTab } from './StatsTab';
import { AdvancedSearchTab } from './AdvancedSearchTab';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('inbox');
  const [activeLogTab, setActiveLogTab] = useState<'queue' | 'review' | 'needs_jd' | 'context' | 'aim_fit' | 'graveyard'>('queue');
  
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedTab = localStorage.getItem('activeTab');
      if (savedTab) setActiveTab(savedTab);
      
      const savedLogTab = localStorage.getItem('activeLogTab');
      if (savedLogTab) setActiveLogTab(savedLogTab as any);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('activeTab', activeTab);
    }
  }, [activeTab]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('activeLogTab', activeLogTab);
    }
  }, [activeLogTab]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<any[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMessage, setSearchMessage] = useState('Processing...');
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0, cost: 0 });
  const [selectedJob, setSelectedJob] = useState<any | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [tabSorts, setTabSorts] = useState<Record<string, string>>({});
  const latestFetchRef = useRef<string>('');
  
  const [pipelineState, setPipelineState] = useState<any>(null);
  const prevPipelineState = useRef<any>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/pipeline/status');
        const data = await res.json();
        setPipelineState(data);
      } catch (e) {}
    };
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 3000);
    return () => clearInterval(statusInterval);
  }, []);

  useEffect(() => {
    if (prevPipelineState.current?.isRunning && !pipelineState?.isRunning) {
      // Pipeline just finished!
      if (pipelineState?.currentStep === 'Idle') {
        // Refresh the jobs list to show newly scored/scraped jobs
        fetchJobs(activeTab);
      }
    }
    prevPipelineState.current = pipelineState;
  }, [pipelineState]);

  const fetchUsage = async () => {
    try {
      const res = await fetch('/api/usage');
      const data = await res.json();
      setUsage(data);
    } catch (e) {
      console.error('Failed to fetch usage', e);
    }
  };

  useEffect(() => {
    fetchUsage();
  }, []);

  const fetchJobs = async (status: string) => {
    latestFetchRef.current = status;
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs?status=${status}`, { cache: "no-store" });
      const data = await res.json();
      
      if (latestFetchRef.current !== status) return;
      
      const allJobs = data.jobs || [];
      
      const displayJobs = allJobs;
      
      // Filter out queued/scoring jobs if we're in the inbox
      if (status === 'inbox') {
        setJobs(displayJobs.filter((j: any) => j.scoringStatus === 'scored'));
      } else {
        setJobs(displayJobs);
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (activeTab !== 'log' && activeTab !== 'stats') {
      fetchJobs(activeTab);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!globalSearchQuery.trim()) {
      setGlobalSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/jobs/search?q=${encodeURIComponent(globalSearchQuery)}`);
        const data = await res.json();
        setGlobalSearchResults(data.jobs);
      } catch (e) {
        console.error('Failed to search', e);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [globalSearchQuery]);

  const handleStatusChange = async (id: string, status: string, reason?: string) => {
    try {
      if (status === 'passed') {
        await fetch(`/api/jobs/${id}/pass`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
      } else if (status === 'promoted') {
        await fetch(`/api/jobs/${id}/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
      } else {
        await fetch(`/api/jobs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
      }
      setJobs((prev: any[]) => prev.filter(j => j.id !== id));
      setSelectedJob((prev: any) => (prev && prev.id === id ? { ...prev, status: status || 'passed' } : prev));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jobStatusChanged', { detail: { id, status: status || 'passed' } }));
      }
    } catch (e) {
      console.error('Failed to update status', e);
    }
  };

  const handleJobUpdate = (id: string, updates: any) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...updates } : j));
    setSelectedJob((prev: any) => (prev && prev.id === id ? { ...prev, ...updates } : prev));
  };

  const handleToggleTailoring = async (id: string, isStaged: boolean) => {
    try {
      await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tailoringStaged: isStaged })
      });
      setJobs(prev => {
        if (activeTab === 'inbox' && isStaged) return prev.filter(j => j.id !== id);
        if (activeTab === 'tailoring' && !isStaged) return prev.filter(j => j.id !== id);
        return prev.map(j => j.id === id ? { ...j, tailoringStaged: isStaged } : j);
      });
      if (selectedJob && selectedJob.id === id) {
        setSelectedJob({ ...selectedJob, tailoringStaged: isStaged });
      }
    } catch (e) {
      console.error('Failed to toggle tailoring', e);
    }
  };

  const handleAutoSearch = async () => {
    try {
      setPipelineState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing pipeline' });
      await fetch('/api/pipeline/run', { method: 'POST' });
    } catch (e) {
      console.error('Failed to start pipeline', e);
    }
  };

  const cancelSearch = () => {
    // Pipeline cannot be cancelled from the UI easily right now
  };

  const groupedJobs = {
    'no-tailoring': jobs.filter(j => j.fitCategory === 'no-tailoring' || j.fitCategory === 'promoted'),
    'minor': jobs.filter(j => j.fitCategory === 'minor'),
    'moderate': jobs.filter(j => j.fitCategory === 'moderate'),
    'major': jobs.filter(j => j.fitCategory === 'major'),
  };

  const currentSort = tabSorts[activeTab] || 'aim_fit';

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setTabSorts(prev => ({ ...prev, [activeTab]: e.target.value }));
  };

  const getSortedJobs = (jobList: any[], sortMode: string) => {
    const sorted = [...jobList];
    if (sortMode === 'newest') {
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } else if (sortMode === 'oldest') {
      sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } else if (sortMode === 'aim_fit') {
      sorted.sort((a, b) => (b.aimFitScore || 0) - (a.aimFitScore || 0));
    } else if (sortMode === 'experience_fit') {
      sorted.sort((a, b) => (b.reqFitScore || 0) - (a.reqFitScore || 0));
    } else if (sortMode === 'travel_fit') {
      sorted.sort((a, b) => (b.travelScore || 0) - (a.travelScore || 0));
    }
    return sorted;
  };

  const renderJobGrid = (displayJobs: any[], sortMode: string) => {
    if (sortMode === 'grouped') {
      const grouped = {
        'promoted': displayJobs.filter(j => j.fitCategory === 'promoted'),
        'no-tailoring': displayJobs.filter(j => j.fitCategory === 'no-tailoring'),
        'minor': displayJobs.filter(j => j.fitCategory === 'minor'),
        'moderate': displayJobs.filter(j => j.fitCategory === 'moderate'),
        'major': displayJobs.filter(j => j.fitCategory === 'major'),
      };
      const renderGroup = (key: 'promoted' | 'no-tailoring' | 'minor' | 'moderate' | 'major', label: string) => {
        if (grouped[key].length === 0) return null;
        return (
          <div style={{ marginBottom: '24px' }}>
            <div className="section-label" style={{ color: 'var(--text)' }}>{label}</div>
            <div className="job-grid">
              {grouped[key].map(job => (
                <JobCard key={job.id} job={job} onClick={() => setSelectedJob(job)} primaryScore="resume" onJobUpdate={handleJobUpdate} showAtsBadge={activeTab === 'tailoring'} />
              ))}
            </div>
          </div>
        );
      };
      return (
        <>
          {renderGroup('promoted', 'Promoted Jobs ⭐')}
          {renderGroup('no-tailoring', 'No Tailoring Required')}
          {renderGroup('minor', 'Minor Tailoring')}
          {renderGroup('moderate', 'Moderate Tailoring')}
          {renderGroup('major', 'Major Tailoring / Missing Skills')}
        </>
      );
    } else {
      const sorted = getSortedJobs(displayJobs, sortMode);
      return (
        <div className="job-grid">
          {sorted.map(job => (
            <JobCard key={job.id} job={job} onClick={() => setSelectedJob(job)} primaryScore={sortMode === 'experience_fit' ? 'experience' : 'aim'} onJobUpdate={handleJobUpdate} showAtsBadge={activeTab === 'tailoring'} />
          ))}
        </div>
      );
    }
  };

  const tabs = ['inbox', 'tailoring', 'bookmarked', 'applied', 'interviewing', 'archived', 'expired', 'passed', 'dismissed', 'log', 'linkedin', 'stats', 'advanced'];

  return (
    <>
      <header className="topbar" style={{ borderBottom: activeTab === 'log' ? 'none' : '1px solid #111' }}>
        <nav className="nav-tabs">
          {tabs.map(tab => (
            <button 
              key={tab}
              className={`nav-tab ${activeTab === tab ? 'active' : ''} ${activeTab === 'log' && tab === 'log' ? 'log-active-trunk' : ''}`}
              onClick={() => {
                setActiveTab(tab);
                setGlobalSearchQuery('');
                setGlobalSearchResults(null);
                setSelectedJob(null);
              }}
              style={{ textTransform: 'capitalize' }}
            >
              {tab}
            </button>
          ))}
        </nav>

        <div className="actions">
          <input 
            type="search" 
            placeholder="Search everywhere..." 
            value={globalSearchQuery}
            onChange={(e) => setGlobalSearchQuery(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: '14px', width: '250px' }}
          />
          {pipelineState?.isRunning ? (
            <button 
              className="btn btn-danger" 
              onClick={cancelSearch}
              disabled
            >
              Pipeline Running...
            </button>
          ) : (
            <button 
              className="btn btn-primary" 
              onClick={handleAutoSearch}
            >
              Search Boards
            </button>
          )}
        </div>
      </header>

      {activeTab === 'log' && (
        <div className="sub-topbar" style={{ position: 'sticky', top: '52px', zIndex: 199, background: 'var(--card)', borderBottom: '1px solid var(--border)', padding: '0 28px', display: 'flex', gap: '16px', height: '44px', alignItems: 'center', margin: 0, width: '100%' }}>
          {['context', 'needs_jd', 'aim_fit', 'review', 'graveyard'].map(logTab => (
            <button
              key={logTab}
              className={`nav-tab ${activeLogTab === logTab ? 'active-sub' : ''}`}
              onClick={() => setActiveLogTab(logTab as any)}
              style={{
                textTransform: 'capitalize',
                fontSize: '12px',
                color: activeLogTab === logTab ? 'var(--text)' : 'var(--muted)'
              }}
            >
              {logTab === 'needs_jd' ? 'Needs JD' : logTab === 'context' ? 'Context DB' : logTab === 'aim_fit' ? 'A/E Fit' : logTab === 'graveyard' ? 'Graveyard' : 'Review'}
            </button>
          ))}
        </div>
      )}

      {pipelineState?.isRunning && (
        <div style={{ padding: '0 28px' }}>
          <div className="progress-container">
            <div className="progress-bar" style={{ width: '100%', animation: 'pulse 2s infinite' }}></div>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--accent)', marginTop: '4px', textAlign: 'center' }}>
            {pipelineState.currentStep}: {pipelineState.stepProgress}
          </div>
        </div>
      )}

      <div className="body-wrap">
        <main className="main" id="main">
          {globalSearchQuery.trim() ? (
            <div>
              <div className="section-label">Search Results for "{globalSearchQuery}" ({globalSearchResults?.length || 0})</div>
              {!globalSearchResults ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>Searching...</div>
              ) : (
                <div className="job-grid">
                  {globalSearchResults.map((j: any) => (
                    <JobCard key={j.id} job={j} onClick={() => setSelectedJob(j)} primaryScore={currentSort === 'experience_fit' ? 'experience' : 'resume'} onJobUpdate={handleJobUpdate} showAtsBadge={activeTab === 'tailoring'} />
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'log' ? (
            <ScoringLogTab onSelectJob={setSelectedJob} activeLogTab={activeLogTab} pipelineState={pipelineState} />
          ) : activeTab === 'linkedin' ? (
            <LinkedInTab />
          ) : activeTab === 'stats' ? (
            <StatsTab />
          ) : activeTab === 'advanced' ? (
            <AdvancedSearchTab />
          ) : loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>Loading...</div>
          ) : jobs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>No jobs found in {activeTab}.</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div className="section-label" style={{ margin: 0 }}>{jobs.length} results — {activeTab}</div>
                  {activeTab === 'tailoring' && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button 
                        className="btn btn-primary" 
                        onClick={() => window.open('/api/tailoring/export', '_blank')}
                        disabled={jobs.length === 0}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', fontSize: '13px' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                          <polyline points="7 10 12 15 17 10"></polyline>
                          <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Export Batch JSON
                      </button>
                      
                      <input 
                        type="file" 
                        accept=".json" 
                        id="import-json-upload" 
                        style={{ display: 'none' }} 
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          try {
                            const text = await file.text();
                            const payload = JSON.parse(text);
                            const res = await fetch('/api/tailoring/import', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(payload)
                            });
                            if (res.ok) {
                              alert("Tailored resumes imported successfully.");
                              // Optionally refresh jobs
                              fetchJobs(activeTab);
                            } else {
                              alert("Failed to import JSON.");
                            }
                          } catch (err) {
                            console.error(err);
                            alert("Invalid JSON file.");
                          }
                          // Reset input
                          e.target.value = '';
                        }}
                      />
                      <button 
                        className="btn btn-primary" 
                        onClick={() => document.getElementById('import-json-upload')?.click()}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', fontSize: '13px', background: 'var(--accent)', borderColor: 'var(--accent)' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                          <polyline points="17 8 12 3 7 8"></polyline>
                          <line x1="12" y1="3" x2="12" y2="15"></line>
                        </svg>
                        Import JSON
                      </button>
                    </div>
                  )}
                </div>
                {['inbox', 'tailoring', 'bookmarked', 'applied', 'interviewing', 'archived', 'expired', 'passed', 'dismissed'].includes(activeTab) && (
                  <select 
                    value={currentSort} 
                    onChange={handleSortChange}
                    style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: '14px' }}
                  >
                    <option value="grouped">Group by Aim Fit</option>
                    <option value="newest">Newest to Oldest</option>
                    <option value="oldest">Oldest to Newest</option>
                    <option value="aim_fit">Highest Aim Fit Score</option>
                    <option value="experience_fit">Highest Experience Fit Score</option>
                    <option value="travel_fit">Highest Travel Score</option>
                  </select>
                )}
              </div>
              
              {renderJobGrid(jobs, currentSort)}
            </>
          )}
        </main>
        
        {selectedJob && (
          <ExpandOverlay 
            job={selectedJob} 
            onClose={() => setSelectedJob(null)} 
            onStatusChange={handleStatusChange} 
            onToggleTailoring={handleToggleTailoring}
            onJobUpdate={handleJobUpdate}
            primaryScore={currentSort === 'experience_fit' ? 'experience' : 'resume'}
          />
        )}
      </div>
    </>
  );
}
