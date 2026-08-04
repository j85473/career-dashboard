'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { JobListItem } from '@/types/job';
import { showAlert } from '@/lib/modal';

type LogTab = 'local_scoring' | 'needs_jd' | 'aim_fit' | 'context';

interface ScoringLogTabProps {
  onSelectJob?: (job: JobListItem) => void;
  activeLogTab: string;
  pipelineState?: {
    isRunning?: boolean;
    currentStep?: string;
    stepProgress?: string;
  } | null;
}

interface NativeScoringRequestView {
  id: string;
  status: string;
  phase: string;
  progress: string;
  error: string | null;
  counts: { context: number; standard: number };
  runs: { context: number; standard: number };
  updatedAt: string;
}

export function ScoringLogTab({ onSelectJob, activeLogTab, pipelineState }: ScoringLogTabProps) {
  const currentTab: LogTab = ['local_scoring', 'needs_jd', 'aim_fit', 'context'].includes(activeLogTab)
    ? activeLogTab as LogTab
    : 'local_scoring';
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nativeRequest, setNativeRequest] = useState<NativeScoringRequestView | null>(null);
  const [nativeRequestBusy, setNativeRequestBusy] = useState(false);
  const nativeActive = Boolean(nativeRequest && ['queued', 'running'].includes(nativeRequest.status));

  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const fetchNativeRequest = useCallback(async () => {
    try {
      const response = await fetch('/api/scoring/requests', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      setNativeRequest(payload.request || null);
    } catch {
      // Job-list errors remain the primary inline error; status polling retries.
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(fetchNativeRequest, 0);
    const interval = setInterval(fetchNativeRequest, 5_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [fetchNativeRequest]);

  const startNativeScoring = async () => {
    setNativeRequestBusy(true);
    try {
      const response = await fetch('/api/scoring/requests', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Native scoring could not be queued.');
      setNativeRequest(payload.request || null);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Native scoring could not be queued.');
    } finally {
      setNativeRequestBusy(false);
    }
  };

  const retryNativeScoring = async () => {
    if (!nativeRequest) return;
    setNativeRequestBusy(true);
    try {
      const response = await fetch(`/api/scoring/requests/${nativeRequest.id}/retry`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Native scoring could not be retried.');
      setNativeRequest(payload.request || null);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Native scoring could not be retried.');
    } finally {
      setNativeRequestBusy(false);
    }
  };


  const fetchJobs = useCallback(async (page = 1, append = false, quiet = false) => {
    if (quiet && abortRef.current) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!quiet) {
      if (append) setLoadingMore(true);
      else setLoading(true);
    }
    setError('');
    try {
      const params = new URLSearchParams({
        status: 'log',
        logTab: currentTab,
        sort: 'newest',
        page: String(page),
        limit: '50',
      });
      const res = await fetch(`/api/jobs?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error('Could not load the scoring log.');
      const data = await res.json();
      setJobs((previous) => append ? [...previous, ...(data.jobs || [])] : (data.jobs || []));
      setPagination(data.pagination || { page, total: data.jobs?.length || 0, hasMore: false });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(reason instanceof Error ? reason.message : 'Could not load the scoring log.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        if (!quiet) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    }
  }, [currentTab]);

  useEffect(() => {
    const timer = setTimeout(() => fetchJobs(), 0);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [fetchJobs]);

  useEffect(() => {
    if ((!pipelineState?.isRunning && !nativeActive) || loading || loadingMore) return;
    const interval = setInterval(() => fetchJobs(1, false, true), 8_000);
    return () => clearInterval(interval);
  }, [pipelineState?.isRunning, nativeActive, loading, loadingMore, fetchJobs]);

  useEffect(() => {
    if (!nativeRequest?.status || nativeActive) return;
    const finalRefresh = setTimeout(() => fetchJobs(1, false, true), 0);
    return () => clearTimeout(finalRefresh);
  }, [nativeRequest?.status, nativeActive, fetchJobs]);

  useEffect(() => {
    const refresh = () => fetchJobs(1, false, true);
    window.addEventListener('jobStatusChanged', refresh);
    return () => window.removeEventListener('jobStatusChanged', refresh);
  }, [fetchJobs]);

  const startPipeline = async (endpoint: string) => {
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 400 && data.message === 'Pipeline already running') {
          // Pipeline is already running, no need to alert. Polling will sync the state.
          return;
        }
        throw new Error(data.error || data.message || 'The pipeline could not be started.');
      }
      window.dispatchEvent(new CustomEvent('pipelineStatusRefresh'));
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'The pipeline could not be started.');
    }
  };


  const row = (job: JobListItem, detail?: React.ReactNode) => (
    <button key={job.id} type="button" className="log-job-row" onClick={() => onSelectJob?.(job)}>
      <span>
        <strong>{job.company}</strong>
        <span>{job.title}</span>
        {detail}
      </span>
    </button>
  );

  const content = () => {
    if (currentTab === 'needs_jd') {
      const queued = jobs.filter((job) => job.scoringStatus === 'needs_jd' && !job.jdBatchId);
      const processing = jobs.filter((job) => Boolean(job.jdBatchId));
      return (
        <div className="log-sections">
          <section className="log-action-panel">
            <div>
              <strong>JD Extraction</strong>
              <p>{queued.length} jobs are waiting for job-description extraction via Jina.</p>
            </div>
            <button className="btn btn-primary" disabled={pipelineState?.isRunning || queued.length === 0} onClick={() => startPipeline('/api/pipeline/extraction')}>
              {pipelineState?.isRunning ? 'Pipeline running…' : 'Run extraction'}
            </button>
          </section>
          {processing.length > 0 && (
            <section style={{ background: 'rgba(0,111,255,0.05)', border: '1px solid rgba(0, 111, 255, 0.2)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
              <div className="section-label" style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <div className="ticker-pulse" style={{ display: 'inline-block' }}></div>
                Jina is currently processing
              </div>
              <div className="log-list">{processing.map((job) => row(job))}</div>
            </section>
          )}
          <section>
            <div className="log-list">{queued.length ? queued.map((job) => row(job, job.scoreError ? <em>{job.scoreError}</em> : undefined)) : <div className="empty-state">No jobs waiting.</div>}</div>
          </section>
        </div>
      );
    }

    if (currentTab === 'context') {
      return (
        <div className="log-sections">
          <section className="log-action-panel">
            <div>
              <strong>Context Update Batch</strong>
              <p>{jobs.length} decisions are waiting to update the context database.</p>
            </div>
          </section>
          <p className="log-help">Only intentional passed-job decisions are learned. Applied/interviewing jobs and Expired decisions are excluded.</p>
          <div className="log-list">{jobs.length ? jobs.map((job) => row(job, <em>Status: {job.status}</em>)) : <div className="empty-state">No context updates waiting.</div>}</div>
        </div>
      );
    }

    if (currentTab === 'aim_fit') {
      return (
        <div className="log-sections">
          <section className="log-action-panel">
            <div>
              <strong>Native Antigravity Scoring</strong>
              <p aria-live="polite">
                {nativeRequest
                  ? `${nativeRequest.progress} Context ${nativeRequest.counts.context} · A/E ${nativeRequest.counts.standard}`
                  : 'One request updates negative context, then scores pending A/E fit jobs.'}
              </p>
              {nativeRequest && (
                <span className="log-help">
                  Phase: {nativeRequest.phase.replaceAll('_', ' ')} · Runs: {nativeRequest.runs.context} context / {nativeRequest.runs.standard} A/E
                </span>
              )}
              {nativeRequest?.error && <span className="inline-error" role="alert">{nativeRequest.error}</span>}
            </div>
            {nativeRequest?.status === 'failed' ? (
              <button className="btn btn-primary" disabled={nativeRequestBusy} onClick={retryNativeScoring}>
                {nativeRequestBusy ? 'Queuing…' : 'Retry scoring'}
              </button>
            ) : (
              <button className="btn btn-primary" disabled={nativeRequestBusy || Boolean(nativeActive)} onClick={startNativeScoring}>
                {nativeRequestBusy ? 'Queuing…' : nativeActive ? 'Scoring queued/running…' : 'Score Pending Jobs'}
              </button>
            )}
          </section>
          <div className="log-list">{jobs.length ? jobs.map((job) => row(job)) : <div className="empty-state">No jobs waiting for A/E Fit processing.</div>}</div>
        </div>
      );
    }

    if (currentTab === 'local_scoring') {
      return (
        <div className="log-sections">
          <section className="log-action-panel">
            <div>
              <strong>Local Scoring & Triage</strong>
              <p>{pagination.total} jobs are waiting for local heuristic scoring.</p>
            </div>
            <button className="btn btn-primary" disabled={pipelineState?.isRunning || pagination.total === 0} onClick={() => startPipeline('/api/pipeline/local')}>
              {pipelineState?.isRunning ? 'Pipeline running…' : 'Run scoring'}
            </button>
          </section>
          <div className="log-list">{jobs.length ? jobs.map((job) => row(job)) : <div className="empty-state">No jobs waiting for local scoring.</div>}</div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="scoring-log">
      <div className="scoring-log-toolbar">
        {pipelineState?.isRunning ? (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div className="pipeline-chip" aria-live="polite">
              <strong>{pipelineState.currentStep}</strong>
              <span>{pipelineState.stepProgress}</span>
            </div>
            <button className="btn btn-danger" onClick={() => startPipeline('/api/pipeline/stop')}>Stop</button>
          </div>
        ) : pipelineState?.currentStep === 'Error' || pipelineState?.currentStep === 'Warning' ? (
          <div className="pipeline-chip" role="alert">
            <strong>{pipelineState.currentStep}</strong>
            <span>{pipelineState.stepProgress}</span>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={() => startPipeline('/api/pipeline/run')}>Run full pipeline</button>
        )}
        <span className="result-count">{pagination.total} total</span>
      </div>


      {error ? <div className="inline-error" role="alert">{error}<button className="btn" onClick={() => fetchJobs()}>Try again</button></div>
        : loading ? <div className="empty-state">Loading…</div>
        : content()}

      {pagination.hasMore && (
        <div className="load-more-wrap">
          <button className="btn" disabled={loadingMore} onClick={() => fetchJobs(pagination.page + 1, true)}>
            {loadingMore ? 'Loading…' : `Load more (${pagination.total - jobs.length} remaining)`}
          </button>
        </div>
      )}
    </div>
  );
}
