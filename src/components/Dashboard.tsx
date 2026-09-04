'use client';

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import JobCard from './JobCard';
import { LinkedInTab } from './LinkedInTab';
import { ExpandOverlay } from './ExpandOverlay';
import { ScoringLogTab } from './ScoringLogTab';
import { StatsTab } from './StatsTab';
import { AdvancedSearchTab } from './AdvancedSearchTab';
import { DashboardPanelBoundary } from './DashboardPanelBoundary';
import { startClientPolling } from '@/lib/clientPolling';
import { readBrowserPreference, writeBrowserPreference } from '@/lib/browserStorage';
import { readClientMutationResponse } from '@/lib/clientMutationResponse';
import { showAlert } from '@/lib/modal';
import {
  currentTickerMessage,
  rollingTickerMessageQueue,
} from '@/lib/pipelineTelemetry';
import type { JobListItem, PaginationMeta } from '@/types/job';
import { defaultJobSort } from '@/lib/jobSort';
import { companyDisplayGroupKey, companyDisplayName } from '@/lib/companyPresentation';

type LogTab = 'action_needed' | 'local_scoring' | 'needs_jd' | 'aim_fit' | 'experience_fit' | 'context';
type ArchivedTab = 'archived' | 'bookmarked' | 'cooldown' | 'expired' | 'passed' | 'local_dismissed' | 'dismissed';
type LinkedinTab = 'outreach' | 'posts';
interface PipelineState {
  isRunning?: boolean;
  schedulePaused?: boolean;
  pausedUntil?: string | null;
  currentStep?: string;
  stepProgress?: string;
}

function describePauseRemaining(pausedUntil: string | null | undefined): string {
  if (!pausedUntil) return 'until it is resumed by hand';
  const remainingMs = new Date(pausedUntil).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'resuming now';
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `resuming in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `resuming in ${hours}h ${minutes % 60}m`;
}

function sameCompanyName(left: string, right: string): boolean {
  return companyDisplayGroupKey(left) === companyDisplayGroupKey(right);
}



const LOG_TABS: LogTab[] = ['action_needed', 'local_scoring', 'needs_jd', 'aim_fit', 'experience_fit', 'context'];
const ARCHIVED_TABS: ArchivedTab[] = ['archived', 'bookmarked', 'cooldown', 'expired', 'passed', 'local_dismissed', 'dismissed'];
const LINKEDIN_TABS: LinkedinTab[] = ['posts', 'outreach'];
const DASHBOARD_TABS = ['inbox', 'tailoring', 'applied', 'interviewing', 'archived', 'log', 'linkedin', 'stats', 'advanced'] as const;
const JOB_LIST_TIMEOUT_MS = 15_000;

function appendTickerMessage(scroller: HTMLDivElement, message: string): void {
  const span = document.createElement('span');
  span.className = 'ticker-message';
  span.style.paddingLeft = '0px';
  span.style.paddingRight = '50px';
  span.style.display = 'inline-block';
  span.style.animation = 'none';
  span.textContent = message;
  scroller.appendChild(span);
}

const ContinuousTicker = ({ text }: { text: string }) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const latestTextRef = useRef(currentTickerMessage(text));
  const offsetRef = useRef(0);
  const lastTimeRef = useRef<number>(0);

  // Keep anything already on screen untouched. Replace only the not-yet-seen
  // tail with the newest update, so status changes enter naturally from the
  // right without rewriting words while the user is reading them.
  useEffect(() => {
    const message = currentTickerMessage(text);
    latestTextRef.current = message;

    const scroller = scrollerRef.current;
    const container = scroller?.parentElement;
    if (!scroller || !container) return;

    const children = Array.from(scroller.children) as HTMLElement[];
    const containerRect = container.getBoundingClientRect();
    let enteredCount = 0;
    children.forEach((child, index) => {
      const rect = child.getBoundingClientRect();
      if (rect.left < containerRect.right && rect.right > containerRect.left) enteredCount = index + 1;
    });

    const queuedMessages = rollingTickerMessageQueue(
      children.map((child) => child.textContent || ''),
      enteredCount,
      message,
    );

    let preservedPrefixLength = 0;
    while (
      preservedPrefixLength < children.length
      && preservedPrefixLength < queuedMessages.length
      && children[preservedPrefixLength].textContent === queuedMessages[preservedPrefixLength]
    ) {
      preservedPrefixLength += 1;
    }

    while (scroller.children.length > preservedPrefixLength) scroller.lastElementChild?.remove();
    for (let index = preservedPrefixLength; index < queuedMessages.length; index += 1) {
      appendTickerMessage(scroller, queuedMessages[index]);
    }
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
          appendTickerMessage(scrollerRef.current, latestTextRef.current);
          
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
    <div
      className="ticker-marquee-container"
      aria-label={currentTickerMessage(text)}
      style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center' }}
    >
      <div ref={scrollerRef} style={{ display: 'flex', willChange: 'transform' }}>
        {/* DOM nodes are manually managed by the requestAnimationFrame loop to prevent React from blinking them mid-scroll */}
      </div>
    </div>
  );
};

export default function Dashboard() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const companyFilter = (searchParams.get('company') || '').trim();
  const [activeTab, setActiveTab] = useState('inbox');
  const [activeLogTab, setActiveLogTab] = useState<LogTab>('aim_fit');
  const [activeArchivedTab, setActiveArchivedTab] = useState<ArchivedTab>('archived');
  const [activeLinkedinTab, setActiveLinkedinTab] = useState<LinkedinTab>('posts');

  
  useEffect(() => {
    const timer = setTimeout(() => {
      const savedTab = readBrowserPreference('activeTab');
      if (savedTab && DASHBOARD_TABS.includes(savedTab as typeof DASHBOARD_TABS[number])) setActiveTab(savedTab);
      
      const savedLogTab = readBrowserPreference('activeLogTab');
      if (savedLogTab === 'wildcard_fit') {
        writeBrowserPreference('activeLogTab', 'aim_fit');
        setActiveLogTab('aim_fit');
      } else if (savedLogTab && LOG_TABS.includes(savedLogTab as LogTab)) {
        setActiveLogTab(savedLogTab as LogTab);
      }

      const savedArchivedTab = readBrowserPreference('activeArchivedTab');
      if (savedArchivedTab && ARCHIVED_TABS.includes(savedArchivedTab as ArchivedTab)) {
        setActiveArchivedTab(savedArchivedTab as ArchivedTab);
      }
      
      const savedLinkedinTab = readBrowserPreference('activeLinkedinTab');
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
  const [companyResults, setCompanyResults] = useState<JobListItem[] | null>(null);
  const [companyPagination, setCompanyPagination] = useState({ page: 1, total: 0, hasMore: false });
  const [companyLoading, setCompanyLoading] = useState(false);
  const [companyError, setCompanyError] = useState('');
  const [selectedJob, setSelectedJob] = useState<JobListItem | null>(null);
  const [tabSorts, setTabSorts] = useState<Record<string, string>>({});
  const jobsAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const companyAbortRef = useRef<AbortController | null>(null);
  const jobCacheRef = useRef(new Map<string, { jobs: JobListItem[]; pagination: PaginationMeta; cachedAt: number }>());
  
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null);
  const prevPipelineState = useRef<PipelineState | null>(null);

  useEffect(() => {
    const polling = startClientPolling({
      request: async (signal) => {
        const res = await fetch('/api/pipeline/status', { signal });
        if (!res.ok) throw new Error('Could not load pipeline status.');
        return await res.json() as PipelineState;
      },
      onData: (data) => {
        setPipelineState((previous) => JSON.stringify(previous) === JSON.stringify(data) ? previous : data);
      },
      intervalMs: () => {
        const interval = pipelineState?.isRunning ? 3000 : 10000;
        return document.hidden ? Math.max(interval, 30000) : interval;
      },
    });
    window.addEventListener('pipelineStatusRefresh', polling.refresh);

    return () => {
      polling.stop();
      window.removeEventListener('pipelineStatusRefresh', polling.refresh);
    };
  }, [pipelineState?.isRunning]);

  const dataStatus = activeTab === 'archived' ? activeArchivedTab : activeTab;
  const currentSort = tabSorts[dataStatus] || defaultJobSort(dataStatus);

  const updateCompanyUrl = useCallback((company: string | null, mode: 'push' | 'replace' = 'push') => {
    const params = new URLSearchParams(searchParams.toString());
    if (company?.trim()) params.set('company', company.trim());
    else params.delete('company');
    const nextUrl = params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
    if (mode === 'replace') window.history.replaceState(null, '', nextUrl);
    else window.history.pushState(null, '', nextUrl);
  }, [pathname, searchParams]);

  const fetchJobs = useCallback(async (status: string, options: { page?: number; append?: boolean; force?: boolean; sort?: string } = {}) => {
    const page = options.page || 1;
    const sort = options.sort || tabSorts[status] || defaultJobSort(status);
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
    let timedOut = false;
    const requestTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, JOB_LIST_TIMEOUT_MS);
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
      setJobs((previous) => {
        if (!options.append) return nextJobs;
        const existingIds = new Set(previous.map(j => j.id));
        const filteredNext = nextJobs.filter((j: JobListItem) => !existingIds.has(j.id));
        return [...previous, ...filteredNext];
      });
      setPagination(nextPagination);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (timedOut) setListError('This tab took too long to load. Try again.');
        return;
      }
      console.error(error);
      setListError(error instanceof Error ? error.message : 'Could not load jobs.');
    } finally {
      clearTimeout(requestTimeout);
      if (jobsAbortRef.current === controller) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [tabSorts]);

  const runCompanySearch = useCallback(async (company: string, page = 1, append = false) => {
    companyAbortRef.current?.abort();
    const controller = new AbortController();
    companyAbortRef.current = controller;
    setCompanyLoading(true);
    setCompanyError('');
    if (!append) setCompanyResults(null);
    try {
      const params = new URLSearchParams({ company, page: String(page), limit: '48' });
      const res = await fetch(`/api/jobs/search?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error('Could not load company jobs.');
      const data = await res.json();
      setCompanyResults((previous) => {
        const nextJobs = data.jobs || [];
        if (!append) return nextJobs;
        const existingIds = new Set((previous || []).map(job => job.id));
        return [...(previous || []), ...nextJobs.filter((job: JobListItem) => !existingIds.has(job.id))];
      });
      setCompanyPagination(data.pagination || { page, total: 0, hasMore: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setCompanyError(error instanceof Error ? error.message : 'Could not load company jobs.');
    } finally {
      if (companyAbortRef.current === controller) setCompanyLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!companyFilter) {
      companyAbortRef.current?.abort();
      return;
    }
    const timer = setTimeout(() => void runCompanySearch(companyFilter), 0);
    return () => {
      clearTimeout(timer);
      companyAbortRef.current?.abort();
    };
  }, [companyFilter, runCompanySearch]);

  useEffect(() => {
    if (!companyFilter && !['log', 'stats', 'linkedin', 'advanced'].includes(activeTab)) {
      fetchJobs(dataStatus, { sort: currentSort });
    }
    return () => jobsAbortRef.current?.abort();
  }, [activeTab, dataStatus, currentSort, fetchJobs, companyFilter]);

  useEffect(() => {
    let companyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    if (prevPipelineState.current?.isRunning && !pipelineState?.isRunning) {
      jobCacheRef.current.clear();
      if (companyFilter) {
        companyRefreshTimer = setTimeout(() => void runCompanySearch(companyFilter), 0);
      } else if (!['log', 'stats', 'linkedin', 'advanced'].includes(activeTab)) {
        fetchJobs(dataStatus, { force: true, sort: currentSort });
      }
    }
    prevPipelineState.current = pipelineState;
    return () => {
      if (companyRefreshTimer) clearTimeout(companyRefreshTimer);
    };
  }, [pipelineState, activeTab, dataStatus, currentSort, fetchJobs, companyFilter, runCompanySearch]);

  const runGlobalSearch = useCallback(async (query: string, page = 1, append = false) => {
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setGlobalSearchLoading(true);
    setGlobalSearchError('');
    try {
      const params = new URLSearchParams({ q: query, page: String(page), limit: '30' });
      if (dataStatus === 'applied') {
        params.set('status', 'applied');
      }
      const res = await fetch(`/api/jobs/search?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error('Search failed.');
      const data = await res.json();
      setGlobalSearchResults((previous) => {
        const nextJobs = data.jobs || [];
        if (!append) return nextJobs;
        const existingIds = new Set((previous || []).map(j => j.id));
        const filteredNext = nextJobs.filter((j: JobListItem) => !existingIds.has(j.id));
        return [...(previous || []), ...filteredNext];
      });
      setGlobalSearchPagination(data.pagination || { page, total: 0, hasMore: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setGlobalSearchError(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      if (searchAbortRef.current === controller) setGlobalSearchLoading(false);
    }
  }, [dataStatus]);

  useEffect(() => {
    const query = globalSearchQuery.trim();
    if (query.length < 2) return;
    const timer = setTimeout(() => runGlobalSearch(query), 350);
    return () => {
      clearTimeout(timer);
      searchAbortRef.current?.abort();
    };
  }, [globalSearchQuery, runGlobalSearch]);
  const handleStatusChange = async (id: string, status: string, reason?: string) => {
    try {
      let res: Response;
      if (status === 'passed') {
        res = await fetch(`/api/jobs/${id}/pass`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
      } else if (status === 'promoted') {
        res = await fetch(`/api/jobs/${id}/promote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
      } else {
        const payload: Partial<JobListItem> = {};
        if (status) payload.status = status;
        if (reason) payload.passReason = reason;

        res = await fetch(`/api/jobs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      const responseData = await readClientMutationResponse(res, 'Failed to update the job.');
      const updatedJob = (responseData.job || responseData) as Partial<JobListItem>;
      const actualStatus = updatedJob.status || (status === 'promoted' ? 'inbox' : status);
      setSelectedJob((previous) => previous?.id === id ? { ...previous, ...updatedJob } : previous);
      jobCacheRef.current.clear();
      if (companyFilter) {
        await runCompanySearch(companyFilter);
      } else if (globalSearchQuery.trim().length >= 2) {
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
    // A rescore response carries the authoritative pending_af status. Remove
    // that row from the currently rendered Inbox collection immediately; a
    // shallow merge alone leaves a stale card visible until the next fetch.
    const leavesInbox = !companyFilter && dataStatus === 'inbox'
      && ((updates.status !== undefined && updates.status !== 'inbox') || updates.tailoringStaged === true);
    const leavesCompanyView = Boolean(
      companyFilter
      && typeof updates.company === 'string'
      && !sameCompanyName(updates.company, companyFilter),
    );
    setJobs(prev => leavesInbox
      ? prev.filter(job => job.id !== id)
      : prev.map(job => job.id === id ? { ...job, ...updates } : job));
    if (leavesInbox) {
      setPagination(previous => {
        const total = Math.max(0, previous.total - 1);
        return {
          ...previous,
          total,
          totalPages: Math.max(1, Math.ceil(total / previous.limit)),
          hasMore: previous.page * previous.limit < total,
        };
      });
    }
    setGlobalSearchResults(prev => prev?.map(job => job.id === id ? { ...job, ...updates } : job) || prev);
    if (leavesCompanyView) {
      setCompanyPagination(previous => ({ ...previous, total: Math.max(0, previous.total - 1) }));
    }
    setCompanyResults(prev => {
      if (!prev) return prev;
      return prev.flatMap(job => {
        if (job.id !== id) return [job];
        const updated = { ...job, ...updates };
        return leavesCompanyView ? [] : [updated];
      });
    });
    setSelectedJob((prev) => (prev && prev.id === id ? { ...prev, ...updates } : prev));
    jobCacheRef.current.clear();
  }, [companyFilter, dataStatus]);

  const handleToggleTailoring = async (id: string, isStaged: boolean) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tailoringStaged: isStaged })
      });
      await readClientMutationResponse(res, 'Failed to update tailoring status.');
      setJobs(prev => {
        if (!companyFilter && activeTab === 'inbox' && isStaged) return prev.filter(j => j.id !== id);
        if (!companyFilter && activeTab === 'tailoring' && !isStaged) return prev.filter(j => j.id !== id);
        return prev.map(j => j.id === id ? { ...j, tailoringStaged: isStaged } : j);
      });
      setCompanyResults(prev => prev?.map(job => job.id === id ? { ...job, tailoringStaged: isStaged } : job) || prev);
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
    if (companyFilter) updateCompanyUrl(null, 'replace');
    searchAbortRef.current?.abort();
    setGlobalSearchQuery(nextQuery);
    setGlobalSearchResults(nextQuery.trim().length < 2 ? [] : null);
    setGlobalSearchPagination({ page: 1, total: 0, hasMore: false });
    setGlobalSearchError('');
  };

  const handleCompanySelect = useCallback((company: string) => {
    const normalizedCompany = company.trim();
    if (!normalizedCompany) return;
    searchAbortRef.current?.abort();
    setGlobalSearchQuery('');
    setGlobalSearchResults(null);
    setGlobalSearchPagination({ page: 1, total: 0, hasMore: false });
    setGlobalSearchError('');
    setSelectedJob(null);
    updateCompanyUrl(normalizedCompany);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [updateCompanyUrl]);

  const clearCompanyFilter = useCallback((mode: 'push' | 'replace' = 'push') => {
    companyAbortRef.current?.abort();
    updateCompanyUrl(null, mode);
  }, [updateCompanyUrl]);

  const renderJobGrid = (displayJobs: JobListItem[], sortMode: string) => {
    return (
      <div className="job-grid">
        {displayJobs.map(job => (
          <JobCard
            key={job.id}
            job={job}
            onSelect={setSelectedJob}
            primaryScore={sortMode === 'experience_fit' ? 'experience' : 'aim'}
            onJobUpdate={handleJobUpdate}
            showAtsBadge={activeTab === 'tailoring'}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="dashboard-shell">
      <header className="topbar">
        <nav className="nav-tabs">
          {DASHBOARD_TABS.map(tab => (
            <button 
              key={tab}
              className={`nav-tab ${activeTab === tab ? 'active' : ''} ${(activeTab === 'log' && tab === 'log') || (activeTab === 'archived' && tab === 'archived') ? 'log-active-trunk' : ''}`}
              onClick={() => {
                // Push, not replace: leaving a company view via the tabs should
                // stay in history so Back returns to it.
                if (companyFilter) clearCompanyFilter();
                setActiveTab(tab);
                writeBrowserPreference('activeTab', tab);
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
            placeholder={['log', 'stats', 'linkedin', 'advanced'].includes(activeTab) ? "Search everywhere..." : `Search ${activeTab}...`} 
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
                {pipelineState?.schedulePaused ? 'Resume Pipeline' : 'Search Boards'}
              </button>
            </>
          )}
        </div>
      </header>

      {/* A pause used to be invisible: cron logged "paused" and exited 0, so a
          forgotten Stop looked exactly like a healthy idle pipeline. */}
      {pipelineState?.schedulePaused && (
        <div className="pipeline-pause-banner" role="status">
          <strong>Ingestion is paused</strong>
          <span>
            {pipelineState.pausedUntil
              ? `Nothing is being ingested or scored — ${describePauseRemaining(pipelineState.pausedUntil)}.`
              : 'Nothing is being ingested or scored. This pause has no expiry and will hold until you resume it.'}
          </span>
          <button className="btn btn-primary" onClick={handleAutoSearch}>Resume now</button>
        </div>
      )}

      {activeTab === 'log' && (
        <div className="sub-topbar">
          {LOG_TABS.map(logTab => (
            <button
              key={logTab}
              className={`nav-tab ${activeLogTab === logTab ? 'active-sub' : ''}`}
              onClick={() => {
                setActiveLogTab(logTab);
                writeBrowserPreference('activeLogTab', logTab);
              }}
              style={{
                textTransform: 'capitalize',
                fontSize: '12px',
                color: activeLogTab === logTab ? 'var(--text)' : 'var(--muted)'
              }}
            >
              {logTab === 'action_needed' ? 'Action Needed' : logTab === 'needs_jd' ? 'Needs JD' : logTab === 'context' ? 'Context DB' : logTab === 'aim_fit' ? 'Aim Fit' : logTab === 'experience_fit' ? 'Experience Fit' : logTab === 'local_scoring' ? 'Local Scoring' : logTab}
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
                writeBrowserPreference('activeArchivedTab', aTab);
              }}
              style={{
                textTransform: 'capitalize',
                fontSize: '12px',
                color: activeArchivedTab === aTab ? 'var(--text)' : 'var(--muted)'
              }}
            >
              {aTab === 'dismissed' ? 'General Rejects' : aTab === 'local_dismissed' ? 'Local Rejects' : aTab === 'cooldown' ? 'Cooldown (Parked)' : aTab === 'bookmarked' ? 'Bookmarked' : aTab}
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
                writeBrowserPreference('activeLinkedinTab', lTab);
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
          <DashboardPanelBoundary
            key={`${activeTab}:${companyFilter}:${Boolean(globalSearchQuery.trim())}`}
            label="This panel"
          >
          {companyFilter ? (
            <div>
              <div className="company-results-toolbar">
                <div className="section-label">All jobs at {companyDisplayName(companyFilter)} across the Dashboard ({companyPagination.total})</div>
                <button type="button" className="btn" onClick={() => clearCompanyFilter()}>Clear company filter</button>
              </div>
              {companyError ? (
                <div className="inline-error" role="alert">
                  {companyError}
                  <button className="btn" onClick={() => runCompanySearch(companyFilter)}>Try again</button>
                </div>
              ) : !companyResults || (companyLoading && companyResults.length === 0) ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>Loading company jobs...</div>
              ) : companyResults.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>No jobs found for this company.</div>
              ) : (
                <>
                  <div className="job-grid">
                    {companyResults.map((job) => (
                      <JobCard
                        key={job.id}
                        job={job}
                        onSelect={setSelectedJob}
                        primaryScore={currentSort === 'experience_fit' ? 'experience' : 'aim'}
                        onJobUpdate={handleJobUpdate}
                        showStatusBadge
                      />
                    ))}
                  </div>
                  {companyPagination.hasMore && (
                    <div className="load-more-wrap">
                      <button className="btn" disabled={companyLoading} onClick={() => runCompanySearch(companyFilter, companyPagination.page + 1, true)}>
                        {companyLoading ? 'Loading…' : `Load more (${companyPagination.total - companyResults.length} remaining)`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : globalSearchQuery.trim() ? (
            <div>
              <div className="section-label">Search Results {!['log', 'stats', 'linkedin', 'advanced'].includes(activeTab) ? `in ${activeTab}` : ''} for &quot;{globalSearchQuery}&quot; ({globalSearchPagination.total})</div>
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
                      <JobCard key={j.id} job={j} onSelect={setSelectedJob} primaryScore={currentSort === 'experience_fit' ? 'experience' : 'aim'} onJobUpdate={handleJobUpdate} showAtsBadge={activeTab === 'tailoring'} />
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
            <StatsTab onOpenActionNeeded={() => {
              setActiveTab('log');
              setActiveLogTab('action_needed');
              writeBrowserPreference('activeTab', 'log');
              writeBrowserPreference('activeLogTab', 'action_needed');
            }} />
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
              <div className="results-toolbar">
                <div className="results-toolbar-left">
                  <div className="section-label" style={{ margin: 0 }}>{jobs.length} of {pagination.total} results — {dataStatus.replaceAll('_', ' ')}</div>
                  {activeTab === 'tailoring' && (
                    <div className="results-toolbar-actions">
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
                {['inbox', 'tailoring', 'bookmarked', 'applied', 'interviewing', 'archived', 'cooldown', 'expired', 'passed', 'local_dismissed', 'dismissed'].includes(activeTab === 'archived' ? activeArchivedTab : activeTab) && (
                  <select
                    className="results-toolbar-sort"
                    value={currentSort}
                    onChange={handleSortChange}
                  >
                    {dataStatus === 'inbox' && <option value="combined">Combined Sort</option>}
                    <option value="newest">Newest to Oldest</option>
                    <option value="oldest">Oldest to Newest</option>
                    <option value="aim_fit">Highest Aim Fit Score</option>
                    <option value="experience_fit">Highest Experience Fit Score</option>
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
          </DashboardPanelBoundary>
        </main>
        
        {selectedJob && (
          <ExpandOverlay
            job={selectedJob}
            onClose={() => setSelectedJob(null)}
            onStatusChange={handleStatusChange}
            onToggleTailoring={handleToggleTailoring}
            onJobUpdate={handleJobUpdate}
            onCompanySelect={handleCompanySelect}
            primaryScore={currentSort === 'experience_fit' ? 'experience' : 'aim'}
          />
        )}
      </div>
    </div>
  );
}
