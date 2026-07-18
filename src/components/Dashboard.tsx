'use client';

import React, { useCallback, useState, useEffect, useRef } from 'react';
import JobCard from './JobCard';
import { LinkedInTab } from './LinkedInTab';
import { ExpandOverlay } from './ExpandOverlay';
import { ScoringLogTab } from './ScoringLogTab';
import { StatsTab } from './StatsTab';
import { AdvancedSearchTab } from './AdvancedSearchTab';
import { showAlert } from '@/lib/modal';
import type { JobListItem, PaginationMeta } from '@/types/job';

type LogTab = 'local_scoring' | 'needs_jd' | 'aim_fit' | 'wildcard_fit' | 'context';
type ArchivedTab = 'archived' | 'bookmarked' | 'cooldown' | 'expired' | 'passed' | 'local_dismissed' | 'dismissed' | 'lucky_dismissed';
type LinkedinTab = 'outreach' | 'posts';
interface PipelineState {
  isRunning?: boolean;
  currentStep?: string;
  stepProgress?: string;
}

type FeedbackScope = 'wildcard';

function isWildcardJob(job: JobListItem): boolean {
  return Boolean(job.luckyStatus && job.luckyStatus !== 'none');
}

const LOG_TABS: LogTab[] = ['local_scoring', 'needs_jd', 'aim_fit', 'wildcard_fit', 'context'];
const ARCHIVED_TABS: ArchivedTab[] = ['archived', 'bookmarked', 'cooldown', 'expired', 'passed', 'local_dismissed', 'dismissed', 'lucky_dismissed'];
const LINKEDIN_TABS: LinkedinTab[] = ['posts', 'outreach'];
const DASHBOARD_TABS = ['inbox', 'lucky_inbox', 'tailoring', 'applied', 'interviewing', 'archived', 'log', 'linkedin', 'stats', 'advanced'] as const;

const ContinuousTicker = ({ text }: { text: string }) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const latestTextRef = useRef(text);
  const offsetRef = useRef(0);
  const lastTimeRef = useRef<number>(0);

  // Keep track of the latest text without triggering re-renders of the DOM elements
  useEffect(() => {
    latestTextRef.current = text;
  }, [text]);

  useEffect(() => {
    let animationId: number;
    const pixelsPerSecond = 80;

    const tick = (time: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = time;
      const dt = (time - lastTimeRef.current) / 1000;
      lastTimeRef.current = time;

      if (scrollerRef.current) {
        offsetRef.current -= pixelsPerSecond * dt;
        
        // Ensure we always have enough children to cover the screen with plenty of buffer
        // so that newly appended children always start off-screen to the far right.
        const containerWidth = scrollerRef.current.parentElement?.getBoundingClientRect().width || window.innerWidth;
        while (scrollerRef.current.scrollWidth < containerWidth + 1000) {
          const span = document.createElement('span');
          span.className = 'ticker-message';
          span.style.paddingLeft = '0px';
          span.style.paddingRight = '50px';
          span.style.display = 'inline-block';
          span.style.animation = 'none';
          span.innerText = latestTextRef.current || 'Waiting for telemetry...';
          scrollerRef.current.appendChild(span);
          
          // Failsafe to prevent infinite loops if scrollWidth doesn't update
          if (scrollerRef.current.children.length > 30) break;
        }

        // If the first child has scrolled completely out of view
        const firstChild = scrollerRef.current.firstElementChild as HTMLElement;
        if (firstChild) {
          const width = firstChild.getBoundingClientRect().width;
          if (offsetRef.current <= -width) {
            // Remove the first child
            scrollerRef.current.removeChild(firstChild);
            // Adjust offset to make it seamless
            offsetRef.current += width;
          }
        }
        
        scrollerRef.current.style.transform = `translateX(${offsetRef.current}px)`;
      }
      animationId = requestAnimationFrame(tick);
    };
    
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, []);

  return (
    <div className="ticker-marquee-container" style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}>
      <div ref={scrollerRef} style={{ display: 'flex', willChange: 'transform' }}>
        {/* DOM nodes are manually managed by the requestAnimationFrame loop to prevent React from blinking them mid-scroll */}
      </div>
    </div>
  );
};

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('inbox');
  const [activeLogTab, setActiveLogTab] = useState<LogTab>('aim_fit');
  const [activeArchivedTab, setActiveArchivedTab] = useState<ArchivedTab>('archived');
  const [activeLinkedinTab, setActiveLinkedinTab] = useState<LinkedinTab>('posts');

  
  useEffect(() => {
    const timer = setTimeout(() => {
      const savedTab = localStorage.getItem('activeTab');
      if (savedTab && DASHBOARD_TABS.includes(savedTab as typeof DASHBOARD_TABS[number])) setActiveTab(savedTab);
      
      const savedLogTab = localStorage.getItem('activeLogTab');
      if (savedLogTab && ['local_scoring', 'needs_jd', 'aim_fit', 'wildcard_fit', 'context'].includes(savedLogTab)) {
        setActiveLogTab(savedLogTab as LogTab);
      }

      const savedArchivedTab = localStorage.getItem('activeArchivedTab');
      if (savedArchivedTab && ARCHIVED_TABS.includes(savedArchivedTab as ArchivedTab)) {
        setActiveArchivedTab(savedArchivedTab as ArchivedTab);
      }
      
      const savedLinkedinTab = localStorage.getItem('activeLinkedinTab');
      if (savedLinkedinTab && LINKEDIN_TABS.includes(savedLinkedinTab as LinkedinTab)) {
        setActiveLinkedinTab(savedLinkedinTab as LinkedinTab);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);



  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ page: 1, limit: 48, total: 0, totalPages: 1, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState('');
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<JobListItem[] | null>(null);
  const [globalSearchPagination, setGlobalSearchPagination] = useState({ page: 1, total: 0, hasMore: false });
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState('');
  const [selectedJob, setSelectedJob] = useState<JobListItem | null>(null);
  const [tabSorts, setTabSorts] = useState<Record<string, string>>({});
  const jobsAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const jobCacheRef = useRef(new Map<string, { jobs: JobListItem[]; pagination: PaginationMeta; cachedAt: number }>());
  
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);
  const prevPipelineState = useRef<PipelineState | null>(null);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/pipeline/status');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setPipelineState((previous) => JSON.stringify(previous) === JSON.stringify(data) ? previous : data);
        }
      } catch {
        // A temporary status failure should not disrupt the rest of the dashboard.
      } finally {
        if (!cancelled) {
          const interval = pipelineState?.isRunning ? 3000 : 10000;
          timeout = setTimeout(fetchStatus, document.hidden ? Math.max(interval, 30000) : interval);
        }
      }
    };
    
    fetchStatus();
    
    const forceRefresh = () => {
      if (timeout) clearTimeout(timeout);
      fetchStatus();
    };
    window.addEventListener('pipelineStatusRefresh', forceRefresh);

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      window.removeEventListener('pipelineStatusRefresh', forceRefresh);
    };
  }, [pipelineState?.isRunning]);

  const dataStatus = activeTab === 'archived' ? activeArchivedTab : activeTab;
  const currentSort = tabSorts[dataStatus] || 'aim_fit';

  const fetchJobs = useCallback(async (status: string, options: { page?: number; append?: boolean; force?: boolean; sort?: string } = {}) => {
    const page = options.page || 1;
    const sort = options.sort || tabSorts[status] || 'aim_fit';
    const cacheKey = `${status}:${sort}:${page}`;
    // Cancel the previous tab's request even when this tab can be served from
    // cache. Otherwise the slower response can arrive later and overwrite it.
    jobsAbortRef.current?.abort();
    jobsAbortRef.current = null;
    const cached = jobCacheRef.current.get(cacheKey);
    if (!options.force && cached && Date.now() - cached.cachedAt < 60_000) {
      setJobs((previous) => options.append ? [...previous, ...cached.jobs] : cached.jobs);
      setPagination(cached.pagination);
      setLoading(false);
      setLoadingMore(false);
      return;
    }

    const controller = new AbortController();
    jobsAbortRef.current = controller;
    if (options.append) setLoadingMore(true);
    else setLoading(true);
    setListError('');
    try {
      const params = new URLSearchParams({ status, sort, page: String(page), limit: '48' });
      const res = await fetch(`/api/jobs?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error('Could not load jobs.');
      const data = await res.json();
      const nextJobs = data.jobs || [];
      const nextPagination = data.pagination || { page, limit: 48, total: nextJobs.length, totalPages: 1, hasMore: false };
      jobCacheRef.current.set(cacheKey, { jobs: nextJobs, pagination: nextPagination, cachedAt: Date.now() });
      setJobs((previous) => options.append ? [...previous, ...nextJobs] : nextJobs);
      setPagination(nextPagination);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error(error);
      setListError(error instanceof Error ? error.message : 'Could not load jobs.');
    } finally {
      if (jobsAbortRef.current === controller) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [tabSorts]);

  useEffect(() => {
    if (!['log', 'stats', 'linkedin', 'advanced'].includes(activeTab)) {
      fetchJobs(dataStatus, { sort: currentSort });
    }
    return () => jobsAbortRef.current?.abort();
  }, [activeTab, dataStatus, currentSort, fetchJobs]);

  useEffect(() => {
    if (prevPipelineState.current?.isRunning && !pipelineState?.isRunning) {
      jobCacheRef.current.clear();
      if (!['log', 'stats', 'linkedin', 'advanced'].includes(activeTab)) {
        fetchJobs(dataStatus, { force: true, sort: currentSort });
      }
    }
    prevPipelineState.current = pipelineState;
  }, [pipelineState, activeTab, dataStatus, currentSort, fetchJobs]);

  const runGlobalSearch = useCallback(async (query: string, page = 1, append = false) => {
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setGlobalSearchLoading(true);
    setGlobalSearchError('');
    try {
      const params = new URLSearchParams({ q: query, page: String(page), limit: '30' });
      const res = await fetch(`/api/jobs/search?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error('Search failed.');
      const data = await res.json();
      setGlobalSearchResults((previous) => append ? [...(previous || []), ...(data.jobs || [])] : (data.jobs || []));
      setGlobalSearchPagination(data.pagination || { page, total: 0, hasMore: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setGlobalSearchError(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      if (searchAbortRef.current === controller) setGlobalSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const query = globalSearchQuery.trim();
    if (query.length < 2) return;
    const timer = setTimeout(() => runGlobalSearch(query), 350);
    return () => {
      clearTimeout(timer);
      searchAbortRef.current?.abort();
    };
  }, [globalSearchQuery, runGlobalSearch]);
  const handleStatusChange = async (id: string, status: string, reason?: string, luckyStatus?: string, feedbackScope?: FeedbackScope) => {
    try {
      let res: Response;
      if (feedbackScope === 'wildcard' && luckyStatus === 'dismissed') {
        res = await fetch(`/api/jobs/${id}/pass`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, scope: 'wildcard' })
        });
      } else if (status === 'passed' && !luckyStatus) {
        res = await fetch(`/api/jobs/${id}/pass`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
      } else if (status === 'promoted') {
        res = await fetch(`/api/jobs/${id}/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, scope: feedbackScope })
        });
      } else {
        const payload: Partial<JobListItem> = {};
        if (status) payload.status = status;
        if (luckyStatus) payload.luckyStatus = luckyStatus;
        if (reason) payload.passReason = reason;

        res = await fetch(`/api/jobs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      const responseData = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(responseData.error || 'Failed to update the job.');
      const updatedJob = (responseData.job || responseData) as Partial<JobListItem>;
      const actualStatus = updatedJob.status || (status === 'promoted' ? 'inbox' : status);
      setSelectedJob((previous) => previous?.id === id ? { ...previous, ...updatedJob } : previous);
      jobCacheRef.current.clear();
      if (globalSearchQuery.trim().length >= 2) {
        await runGlobalSearch(globalSearchQuery.trim());
      } else if (!['log', 'stats', 'linkedin', 'advanced'].includes(activeTab)) {
        await fetchJobs(dataStatus, { force: true, sort: currentSort });
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jobStatusChanged', { detail: { id, status: actualStatus } }));
      }
    } catch (error) {
      console.error('Failed to update status', error);
      await showAlert(error instanceof Error ? error.message : 'Failed to update the job.');
    }
  };

  const handleJobUpdate = useCallback((id: string, updates: Partial<JobListItem>) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...updates } : j));
    setGlobalSearchResults(prev => prev?.map(job => job.id === id ? { ...job, ...updates } : job) || prev);
    setSelectedJob((prev) => (prev && prev.id === id ? { ...prev, ...updates } : prev));
    jobCacheRef.current.clear();
  }, []);

  const handleToggleTailoring = async (id: string, isStaged: boolean) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tailoringStaged: isStaged })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update tailoring status.');
      setJobs(prev => {
        if (activeTab === 'inbox' && isStaged) return prev.filter(j => j.id !== id);
        if (activeTab === 'tailoring' && !isStaged) return prev.filter(j => j.id !== id);
        return prev.map(j => j.id === id ? { ...j, tailoringStaged: isStaged } : j);
      });
      if (selectedJob && selectedJob.id === id) {
        setSelectedJob({ ...selectedJob, tailoringStaged: isStaged });
      }
      jobCacheRef.current.clear();
    } catch (error) {
      console.error('Failed to toggle tailoring', error);
      await showAlert(error instanceof Error ? error.message : 'Failed to update tailoring status.');
    }
  };

  const handleAutoSearch = async () => {
    try {
      setPipelineState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing pipeline' });
      const res = await fetch('/api/pipeline/run', { method: 'POST' });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (res.status === 400 && errorData.message === 'Pipeline already running') {
          // Pipeline is already running, no need to alert. Polling will sync the state.
          return;
        }
        throw new Error(errorData.error || errorData.message || 'The pipeline could not be started.');
      }
    } catch (error) {
      setPipelineState(null);
      console.error('Failed to start pipeline', error);
      await showAlert(error instanceof Error ? error.message : 'The pipeline could not be started.');
    }
  };

  const cancelSearch = async () => {
    try {
      setPipelineState(prev => prev ? { ...prev, currentStep: 'Stopping...' } : null);
      await fetch('/api/pipeline/stop', { method: 'POST' });
    } catch (error) {
      console.error(error);
    }
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setTabSorts(prev => ({ ...prev, [dataStatus]: e.target.value }));
  };

  const handleGlobalSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextQuery = event.target.value;
    searchAbortRef.current?.abort();
    setGlobalSearchQuery(nextQuery);
    setGlobalSearchResults(nextQuery.trim().length < 2 ? [] : null);
    setGlobalSearchPagination({ page: 1, total: 0, hasMore: false });
    setGlobalSearchError('');
  };

  const renderJobGrid = (displayJobs: JobListItem[], sortMode: string) => {
    return (
      <div className="job-grid">
        {displayJobs.map(job => (
          <JobCard key={job.id} job={job} onSelect={setSelectedJob} primaryScore={sortMode === 'experience_fit' ? 'experience' : 'aim'} onJobUpdate={handleJobUpdate} showAtsBadge={activeTab === 'tailoring'} isLucky={isWildcardJob(job)} />
        ))}
      </div>
    );
  };

  return (
    <>
      <header className="topbar">
        <nav className="nav-tabs">
          {DASHBOARD_TABS.map(tab => (
            <button 
              key={tab}
              className={`nav-tab ${activeTab === tab ? 'active' : ''} ${(activeTab === 'log' && tab === 'log') || (activeTab === 'archived' && tab === 'archived') ? 'log-active-trunk' : ''}`}
              onClick={() => {
                setActiveTab(tab);
                localStorage.setItem('activeTab', tab);
                setGlobalSearchQuery('');
                setGlobalSearchResults(null);
                setSelectedJob(null);
              }}
              style={{ textTransform: 'capitalize' }}
            >
              {tab === 'lucky_inbox' ? "I'm Feeling Lucky" : tab}
            </button>
          ))}
        </nav>

        <div className="actions">
          <input 
            type="search" 
            placeholder="Search everywhere..." 
            value={globalSearchQuery}
            onChange={handleGlobalSearchChange}
            style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: '14px', width: '250px' }}
          />
          {pipelineState?.isRunning ? (
            <button 
              className="btn btn-danger" 
              onClick={cancelSearch}
            >
              Stop Pipeline
            </button>
          ) : (
            <>

              <button 
                className="btn btn-primary" 
                onClick={handleAutoSearch}
              >
                Search Boards
              </button>
            </>
          )}
        </div>
      </header>

      {activeTab === 'log' && (
        <div className="sub-topbar">
          {LOG_TABS.map(logTab => (
            <button
              key={logTab}
              className={`nav-tab ${activeLogTab === logTab ? 'active-sub' : ''}`}
              onClick={() => {
                setActiveLogTab(logTab);
                localStorage.setItem('activeLogTab', logTab);
              }}
              style={{
                textTransform: 'capitalize',
                fontSize: '12px',
                color: activeLogTab === logTab ? 'var(--text)' : 'var(--muted)'
              }}
            >
              {logTab === 'needs_jd' ? 'Needs JD' : logTab === 'context' ? 'Context DB' : logTab === 'aim_fit' ? 'A/E Fit' : logTab === 'local_scoring' ? 'Local Scoring' : logTab === 'wildcard_fit' ? 'Wildcard Fit' : logTab}
            </button>
          ))}
        </div>
      )}

      {activeTab === 'archived' && (
        <div className="sub-topbar">
          {ARCHIVED_TABS.map(aTab => (
            <button
              key={aTab}
              className={`nav-tab ${activeArchivedTab === aTab ? 'active-sub' : ''}`}
              onClick={() => {
                setActiveArchivedTab(aTab);
                localStorage.setItem('activeArchivedTab', aTab);
              }}
              style={{
                textTransform: 'capitalize',
                fontSize: '12px',
                color: activeArchivedTab === aTab ? 'var(--text)' : 'var(--muted)'
              }}
            >
              {aTab === 'lucky_dismissed' ? 'Wildcard Rejects' : aTab === 'dismissed' ? 'General Rejects' : aTab === 'local_dismissed' ? 'Local Rejects' : aTab === 'cooldown' ? 'Cooldown (Parked)' : aTab === 'bookmarked' ? 'Bookmarked' : aTab}
            </button>
          ))}
        </div>
      )}

      {activeTab === 'linkedin' && (
        <div className="sub-topbar">
          {LINKEDIN_TABS.map(lTab => (
            <button
              key={lTab}
              className={`nav-tab ${activeLinkedinTab === lTab ? 'active-sub' : ''}`}
              onClick={() => {
                setActiveLinkedinTab(lTab);
                localStorage.setItem('activeLinkedinTab', lTab);
              }}
              style={{
                textTransform: 'capitalize',
                fontSize: '12px',
                color: activeLinkedinTab === lTab ? 'var(--text)' : 'var(--muted)'
              }}
            >
              {lTab === 'outreach' ? 'Outreach' : 'Post Generation'}
            </button>
          ))}
        </div>
      )}

      {pipelineState?.isRunning && (
        <div className="telemetry-ticker-wrapper">
          <div className="telemetry-ticker">
            <div className="ticker-pulse"></div>
            <span className="ticker-step">{pipelineState.currentStep}</span>
            <span className="ticker-divider"></span>
            <ContinuousTicker text={pipelineState.stepProgress || ''} />
          </div>
        </div>
      )}

      <div className="body-wrap">
        <main className="main" id="main">
          {globalSearchQuery.trim() ? (
            <div>
              <div className="section-label">Search Results for &quot;{globalSearchQuery}&quot; ({globalSearchPagination.total})</div>
              {globalSearchError ? (
                <div className="inline-error" role="alert">{globalSearchError}</div>
              ) : !globalSearchResults || (globalSearchLoading && globalSearchResults.length === 0) ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>Searching...</div>
              ) : globalSearchResults.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>No jobs match your search.</div>
              ) : (
                <>
                  <div className="job-grid">
                    {globalSearchResults.map((j) => (
                      <JobCard key={j.id} job={j} onSelect={setSelectedJob} primaryScore={currentSort === 'experience_fit' ? 'experience' : 'aim'} onJobUpdate={handleJobUpdate} showAtsBadge={activeTab === 'tailoring'} isLucky={isWildcardJob(j)} />
                    ))}
                  </div>
                  {globalSearchPagination.hasMore && (
                    <div className="load-more-wrap">
                      <button className="btn" disabled={globalSearchLoading} onClick={() => runGlobalSearch(globalSearchQuery.trim(), globalSearchPagination.page + 1, true)}>
                        {globalSearchLoading ? 'Loading…' : 'Load more search results'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : activeTab === 'log' ? (
            <ScoringLogTab onSelectJob={setSelectedJob} activeLogTab={activeLogTab} pipelineState={pipelineState} />
          ) : activeTab === 'linkedin' ? (
            <LinkedInTab activeSubTab={activeLinkedinTab} />
          ) : activeTab === 'stats' ? (
            <StatsTab />
          ) : activeTab === 'advanced' ? (
            <AdvancedSearchTab />
          ) : listError ? (
            <div className="inline-error" role="alert">
              {listError}
              <button className="btn" onClick={() => fetchJobs(dataStatus, { force: true, sort: currentSort })}>Try again</button>
            </div>
          ) : loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>Loading...</div>
          ) : jobs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>No jobs found in {activeTab}.</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div className="section-label" style={{ margin: 0 }}>{jobs.length} of {pagination.total} results — {dataStatus.replaceAll('_', ' ')}</div>
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
                              await showAlert("Tailored resumes imported successfully.");
                              jobCacheRef.current.clear();
                              fetchJobs(dataStatus, { force: true, sort: currentSort });
                            } else {
                              const error = await res.json().catch(() => ({}));
                              await showAlert(error.error || "Failed to import JSON.");
                            }
                          } catch (err) {
                            console.error(err);
                            await showAlert("Invalid JSON file.");
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
                {['inbox', 'lucky_inbox', 'tailoring', 'bookmarked', 'applied', 'interviewing', 'archived', 'cooldown', 'expired', 'passed', 'local_dismissed', 'dismissed', 'lucky_dismissed'].includes(activeTab === 'archived' ? activeArchivedTab : activeTab) && (
                  <select 
                    value={currentSort} 
                    onChange={handleSortChange}
                    style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: '14px' }}
                  >
                    <option value="newest">Newest to Oldest</option>
                    <option value="oldest">Oldest to Newest</option>
                    <option value="aim_fit">Highest Aim Fit Score</option>
                    <option value="experience_fit">Highest Experience Fit Score</option>
                    <option value="travel_fit">Lowest Travel Required</option>
                  </select>
                )}
              </div>
              
              {renderJobGrid(jobs, currentSort)}
              {pagination.hasMore && (
                <div className="load-more-wrap">
                  <button
                    className="btn"
                    disabled={loadingMore}
                    onClick={() => fetchJobs(dataStatus, { page: pagination.page + 1, append: true, sort: currentSort })}
                  >
                    {loadingMore ? 'Loading…' : `Load more (${pagination.total - jobs.length} remaining)`}
                  </button>
                </div>
              )}
            </>
          )}
        </main>
        
        {selectedJob && (
          <ExpandOverlay 
            key={selectedJob.id}
            job={selectedJob} 
            onClose={() => setSelectedJob(null)} 
            onStatusChange={handleStatusChange} 
            onToggleTailoring={handleToggleTailoring}
            onJobUpdate={handleJobUpdate}
            primaryScore={currentSort === 'experience_fit' ? 'experience' : 'aim'}
          />
        )}
      </div>
    </>
  );
}
