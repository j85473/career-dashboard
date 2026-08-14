'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { JobListItem } from '@/types/job';
import { showAlert, showConfirm } from '@/lib/modal';

type LogTab = 'action_needed' | 'local_scoring' | 'needs_jd' | 'aim_fit' | 'experience_fit' | 'context';

type ManualScoringBatch = {
  id: string;
  stage: 'aim' | 'experience';
  status: 'exported' | 'completed' | 'released' | 'superseded';
  createdAt: string;
  expiresAt: string;
  derivedExpired: boolean;
  exportHash: string;
  _count: { items: number };
};

type ImportProjection = {
  jobId: string;
  ordinal: number;
  company?: string;
  title?: string;
  decision: string;
  variant: string;
  score: number | null;
  band?: string | null;
  applicable: boolean;
  detail: string;
  assessment?: unknown;
  currentStatus?: string;
  proposedStatus?: string;
  lifecycleAction?: 'apply' | 'preserve_protected' | 'release_failed';
  failurePermanence?: 'transient' | 'input_bound';
  failureSeriesOrdinal?: number;
  suppressionActiveAfterApply?: boolean;
};

type ImportPreview = {
  batchId: string;
  stage: 'aim' | 'experience';
  applicable: boolean;
  itemCount: number;
  expectedCount: number;
  suppliedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  safeFailureCount: number;
  cannotEvaluateCount: number;
  doesNotMeetCount: number;
  protectedLifecycleCount: number;
  scoreRange: { minimum: number; maximum: number } | null;
  decisionCounts: Record<string, number>;
  projections: ImportProjection[];
};

type ExportGateStatus = { aim: boolean; experience: boolean };

type AimFailureSummary = {
  id: string;
  jobId: string;
  failureCode: string;
  permanence: string;
  seriesOrdinal: number;
  createdAt: string;
  failureSnapshot: unknown;
  job: { company: string; title: string; status: string };
};

const record = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const records = (value: unknown): Record<string, unknown>[] => (
  Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : []
);

function AimPreviewDetail({ assessment }: { assessment: unknown }) {
  const result = record(assessment);
  if (!result) return null;
  const vector = record(result.factualVector);
  const evidence = new Map(records(vector?.evidenceCatalog).map((entry) => [String(entry.evidenceId), entry]));
  const answers = records(vector?.answers);
  const components = record(result.components);
  const compensation = record(result.compensation);
  const routing = record(result.routingTrace);
  const provenance = record(vector?.provenance);
  const renderAnswers = (values: Record<string, unknown>[]) => values.map((answer) => {
    const citations = Array.isArray(answer.evidenceIds)
      ? answer.evidenceIds.map((id) => evidence.get(String(id))).filter(Boolean) as Record<string, unknown>[]
      : [];
    return (
      <div className="scoring-preview-fact" key={String(answer.questionId)}>
        <strong>{String(answer.questionId)} · {String(answer.answer)}</strong>
        {citations.map((citation) => <blockquote key={String(citation.evidenceId)}>“{String(citation.exactQuote)}”</blockquote>)}
      </div>
    );
  });
  return (
    <details className="scoring-preview-detail">
      <summary>Evidence, components, and provenance</summary>
      {Array.isArray(result.localTriggerCodes) && <p>Local triggers: {result.localTriggerCodes.map(String).join(', ')}</p>}
      {Array.isArray(result.triggerQuestionIds) && <p>Stage 1 triggers: {result.triggerQuestionIds.map(String).join(', ')}</p>}
      {answers.some((answer) => String(answer.questionId).startsWith('S1.')) && <section><strong>Stage 1 facts</strong>{renderAnswers(answers.filter((answer) => String(answer.questionId).startsWith('S1.')))}</section>}
      {compensation && <section><strong>Compensation</strong><p>{String(compensation.comparisonState)} · floor {String(compensation.floorOutcome)} · {String(compensation.reasonCode)}</p><p>Annual bounds: {String(compensation.normalizedAnnualLowerCents)}–{String(compensation.normalizedAnnualUpperCents)} cents</p></section>}
      {components && <section><strong>Components</strong><p>{Object.entries(components).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</p></section>}
      {routing && <section><strong>Routing and caps</strong><pre>{JSON.stringify(routing, null, 2)}</pre></section>}
      {answers.some((answer) => String(answer.questionId).startsWith('S2.')) && <section><strong>Stage 2 evidence</strong>{renderAnswers(answers.filter((answer) => String(answer.questionId).startsWith('S2.')))}</section>}
      {provenance && <section><strong>Extraction provenance</strong><p>{String(provenance.disposition)} · {records(provenance.packets).length} packet receipt(s)</p><pre>{JSON.stringify(provenance, null, 2)}</pre></section>}
    </details>
  );
}

const formatAge = (createdAt: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).valueOf()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

interface ScoringLogTabProps {
  onSelectJob?: (job: JobListItem) => void;
  activeLogTab: string;
  pipelineState?: {
    isRunning?: boolean;
    currentStep?: string;
    stepProgress?: string;
  } | null;
}

export function ScoringLogTab({ onSelectJob, activeLogTab, pipelineState }: ScoringLogTabProps) {
  const currentTab: LogTab = ['action_needed', 'local_scoring', 'needs_jd', 'aim_fit', 'experience_fit', 'context'].includes(activeLogTab)
    ? activeLogTab as LogTab
    : 'local_scoring';
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [approvalExpiresAt, setApprovalExpiresAt] = useState<string | null>(null);
  const [resultPayload, setResultPayload] = useState<unknown>(null);
  const [batches, setBatches] = useState<ManualScoringBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [exportGates, setExportGates] = useState<ExportGateStatus>({ aim: false, experience: false });
  const [activeFailures, setActiveFailures] = useState<AimFailureSummary[]>([]);
  const [retryReasons, setRetryReasons] = useState<Record<string, string>>({});

  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const stage = currentTab === 'experience_fit' ? 'experience' : 'aim';
  const activeBatch = batches.find((batch) => batch.status === 'exported' || batch.status === 'superseded') || null;
  const exportEnabled = exportGates[stage];

  const fetchScoringControls = useCallback(async () => {
    if (currentTab !== 'aim_fit' && currentTab !== 'experience_fit') return;
    try {
      const requests: Promise<Response>[] = [fetch('/api/scoring/config', { cache: 'no-store' })];
      if (currentTab === 'aim_fit') requests.push(fetch('/api/scoring/failures?stage=aim&active=true', { cache: 'no-store' }));
      const responses = await Promise.all(requests);
      const config = await responses[0].json();
      if (!responses[0].ok) throw new Error(config.error || 'Could not load scoring runtime gates.');
      setExportGates(config.exportGates || { aim: false, experience: false });
      if (responses[1]) {
        const failures = await responses[1].json();
        if (!responses[1].ok) throw new Error(failures.error || 'Could not load Aim failure suppressions.');
        setActiveFailures(failures.receipts || []);
      } else {
        setActiveFailures([]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load scoring controls.');
    }
  }, [currentTab]);

  const fetchBatches = useCallback(async () => {
    if (currentTab !== 'aim_fit' && currentTab !== 'experience_fit') return;
    setBatchesLoading(true);
    try {
      const response = await fetch(`/api/scoring/batches?stage=${stage}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load scoring batches.');
      setBatches(body.batches || []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load scoring batches.');
    } finally {
      setBatchesLoading(false);
    }
  }, [currentTab, stage]);

  const downloadStoredBatch = async (batchId: string) => {
    setManualBusy(true);
    try {
      const response = await fetch(`/api/scoring/batches/${batchId}/download`, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Exact batch download failed.');
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || `career-dashboard-${stage}-export-${batchId}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Exact batch download failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const extendBatch = async (batch: ManualScoringBatch) => {
    const base = Math.max(Date.now(), new Date(batch.expiresAt).valueOf());
    const expiresAt = new Date(base + 24 * 60 * 60 * 1000).toISOString();
    if (!await showConfirm(`Extend exact batch ${batch.id} by 24 hours?`)) return;
    setManualBusy(true);
    try {
      const response = await fetch(`/api/scoring/batches/${batch.id}/extend`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresAt }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Batch extension failed.');
      await fetchBatches();
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Batch extension failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const releaseBatch = async (batch: ManualScoringBatch) => {
    if (!await showConfirm(`Release all ${batch._count.items} leases in exact batch ${batch.id}? This result file will no longer be importable.`, 'Release Entire Batch', 'Keep Batch')) return;
    setManualBusy(true);
    try {
      const response = await fetch(`/api/scoring/batches/${batch.id}/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Batch release failed.');
      setPreview(null); setApprovalToken(null); setApprovalExpiresAt(null); setResultPayload(null);
      await Promise.all([fetchBatches(), fetchJobs(1, false, true)]);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Batch release failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const downloadExport = async () => {
    setManualBusy(true);
    try {
      const response = await fetch('/api/scoring/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage, limit: 20 }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Scoring export failed.');
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || `career-dashboard-${stage}-export.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      await fetchBatches();
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Scoring export failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const retryFailure = async (failure: AimFailureSummary) => {
    const reason = (retryReasons[failure.id] || '').normalize('NFC').trim();
    if (!reason || [...reason].length > 500) {
      await showAlert('Enter a manual retry reason of 1–500 characters.');
      return;
    }
    if (!await showConfirm(`Create a locked one-job retry export for ${failure.job.company} — ${failure.job.title}? The current suppression remains active until an approved retry result is applied.`)) return;
    setManualBusy(true);
    try {
      const response = await fetch(`/api/scoring/failures/${failure.id}/retry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Aim failure retry export failed.');
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || `career-dashboard-aim-retry-${failure.jobId}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      setRetryReasons((current) => ({ ...current, [failure.id]: '' }));
      await Promise.all([fetchBatches(), fetchScoringControls()]);
    } catch (reasonValue) {
      await showAlert(reasonValue instanceof Error ? reasonValue.message : 'Aim failure retry export failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const previewResult = async (file: File) => {
    setManualBusy(true);
    try {
      const payload = JSON.parse(await file.text());
      const response = await fetch('/api/scoring/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'preview', payload }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Scoring preview failed.');
      setPreview(body.preview as ImportPreview);
      setApprovalToken(body.approvalToken);
      setApprovalExpiresAt(body.approvalExpiresAt || null);
      setResultPayload(payload);
    } catch (reason) {
      setPreview(null); setApprovalToken(null); setApprovalExpiresAt(null); setResultPayload(null);
      await showAlert(reason instanceof Error ? reason.message : 'Scoring preview failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const applyResult = async () => {
    if (!approvalToken || !resultPayload || !preview || !await showConfirm(`Atomically import ${preview.acceptedCount} validated result(s) and return ${preview.safeFailureCount} failed job(s) to the queue?`)) return;
    setManualBusy(true);
    try {
      const response = await fetch('/api/scoring/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'apply', payload: resultPayload, approvalToken }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Scoring import failed.');
      setPreview(null); setApprovalToken(null); setApprovalExpiresAt(null); setResultPayload(null);
      await showAlert(`Imported ${body.imported} ${stage} result(s); returned ${body.released || 0} failed job(s) to the queue.`);
      await Promise.all([fetchJobs(1, false, true), fetchBatches()]);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Scoring import failed.');
    } finally {
      setManualBusy(false);
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
    const timer = setTimeout(() => { void fetchBatches(); }, 0);
    return () => clearTimeout(timer);
  }, [fetchBatches]);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchScoringControls(); }, 0);
    return () => clearTimeout(timer);
  }, [fetchScoringControls]);

  useEffect(() => {
    if (!pipelineState?.isRunning || loading || loadingMore) return;
    const interval = setInterval(() => fetchJobs(1, false, true), 8_000);
    return () => clearInterval(interval);
  }, [pipelineState?.isRunning, loading, loadingMore, fetchJobs]);

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
    if (currentTab === 'action_needed') {
      return (
        <div className="log-sections">
          <section className="log-action-panel action-needed-panel">
            <div>
              <strong>Scoring jobs requiring intervention</strong>
              <p>{pagination.total} active jobs are failed, retry-exhausted, or in a contradictory lifecycle state.</p>
            </div>
          </section>
          <p className="log-help">These jobs are intentionally excluded from normal queue counts until their state or source data is repaired.</p>
          <div className="log-list">
            {jobs.length ? jobs.map((job) => row(job, (
              <em>
                {job.scoringStatus || 'unknown state'} · {job.scoreAttempts || 0} attempts
                {job.scoreError ? ` · ${job.scoreError}` : ''}
              </em>
            ))) : <div className="empty-state">No active scoring anomalies.</div>}
          </div>
        </div>
      );
    }

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

    if (currentTab === 'aim_fit' || currentTab === 'experience_fit') {
      return (
        <div className="log-sections">
          <section className="log-action-panel log-action-panel-tall">
            <div className="manual-scoring-status">
              <strong>{stage === 'aim' ? 'Aim Fit' : 'Experience Fit'} — Manual Exchange</strong>
              <p>{pagination.total} job(s) are visible in this stage. Export creates one exact leased batch; Codex runs outside the Dashboard.</p>
              <span className="scoring-calibration-badge">
                {stage === 'aim'
                  ? 'Aim v2 · complete-source facts · deterministic score'
                  : 'Hard requirements gate qualification · score ranks qualified survivors only'}
              </span>
              <span className={`scoring-calibration-badge ${exportEnabled ? '' : 'gate-closed'}`}>
                {exportEnabled ? `${stage === 'aim' ? 'Aim' : 'Experience'} v2 export enabled` : `${stage === 'aim' ? 'Aim' : 'Experience'} v2 export closed by runtime gate`}
              </span>
              <span className="log-help">Upload always previews first. Apply atomically imports validated successes and returns failed jobs to this queue.</span>
              {batchesLoading ? <span className="log-help">Loading batch lease…</span> : activeBatch ? (
                <dl className="manual-scoring-grid" aria-label="Active scoring batch">
                  <div><dt>Active batch</dt><dd className="mono-value">{activeBatch.id}</dd></div>
                  <div><dt>Status</dt><dd>{activeBatch.derivedExpired ? 'Expired · still leased' : activeBatch.status}</dd></div>
                  <div><dt>Age</dt><dd>{formatAge(activeBatch.createdAt)}</dd></div>
                  <div><dt>Members</dt><dd>{activeBatch._count.items}</dd></div>
                  <div><dt>Expiry</dt><dd>{new Date(activeBatch.expiresAt).toLocaleString()}</dd></div>
                </dl>
              ) : <span className="log-help">No active {stage} batch lease.</span>}
            </div>
            <div className="log-action-buttons">
              {!activeBatch && <button className="btn btn-primary" disabled={manualBusy || !exportEnabled} title={exportEnabled ? undefined : 'Enable the exact v2 export runtime gate before exporting.'} onClick={downloadExport}>{manualBusy ? 'Working…' : `Export ${stage === 'aim' ? 'Aim' : 'Experience'} Batch`}</button>}
              {activeBatch && <button className="btn btn-secondary" disabled={manualBusy} onClick={() => downloadStoredBatch(activeBatch.id)}>Exact re-download</button>}
              {activeBatch?.status === 'exported' && <button className="btn btn-secondary" disabled={manualBusy} onClick={() => extendBatch(activeBatch)}>Extend 24h</button>}
              {activeBatch && <button className="btn btn-danger" disabled={manualBusy} onClick={() => releaseBatch(activeBatch)}>Release batch</button>}
              <label className="btn btn-secondary">
                Preview Results
                <input type="file" accept="application/json,.json" hidden disabled={manualBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void previewResult(file); event.currentTarget.value = ''; }} />
              </label>
            </div>
          </section>
          {currentTab === 'aim_fit' && activeFailures.length > 0 && (
            <section className="scoring-failure-panel" aria-label="Active Aim failure suppressions">
              <div>
                <strong>Active Aim failure suppressions</strong>
                <p className="log-help">Normal exports cannot bypass these exact input-bound or retry-exhausted identities. A reasoned one-job retry keeps the suppression active until approved apply.</p>
              </div>
              {activeFailures.map((failure) => (
                <div className="scoring-failure-row" key={failure.id}>
                  <span><strong>{failure.job.company}</strong> · {failure.job.title}</span>
                  <span>{failure.failureCode.replaceAll('_', ' ')} · {failure.permanence} · series {failure.seriesOrdinal}</span>
                  <input
                    type="text"
                    maxLength={500}
                    value={retryReasons[failure.id] || ''}
                    onChange={(event) => setRetryReasons((current) => ({ ...current, [failure.id]: event.target.value }))}
                    placeholder="Reason for manual retry"
                    aria-label={`Manual retry reason for ${failure.job.company} ${failure.job.title}`}
                  />
                  <button className="btn btn-secondary" disabled={manualBusy || !exportGates.aim} onClick={() => void retryFailure(failure)}>Download one-job retry</button>
                </div>
              ))}
            </section>
          )}
          <div className="log-list">{jobs.length ? jobs.map((job) => row(job)) : <div className="empty-state">No jobs waiting for {stage === 'aim' ? 'Aim' : 'Experience'} processing.</div>}</div>
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

      {preview && (
        <div className="scoring-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
          <section className="scoring-preview-modal" role="dialog" aria-modal="true" aria-labelledby="scoring-preview-title">
            <div className="scoring-preview-header">
              <div>
                <h2 id="scoring-preview-title">Zero-write {preview.stage === 'aim' ? 'Aim' : 'Experience'} preview</h2>
                <p className="log-help mono-value">{preview.batchId}</p>
              </div>
              <button className="expand-close" aria-label="Close preview" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className={`scoring-preview-verdict ${preview.applicable ? 'applicable' : 'blocked'}`}>
              <strong>{preview.applicable ? `${preview.acceptedCount} result(s) ready · ${preview.safeFailureCount} failure(s) return to queue` : 'Blocked — result contract is invalid'}</strong>
              <span>This preview made no database writes.</span>
            </div>
            <dl className="manual-scoring-grid scoring-preview-summary">
              <div><dt>Membership</dt><dd>{preview.suppliedCount} supplied / {preview.expectedCount} expected</dd></div>
              <div><dt>Validated</dt><dd>{preview.acceptedCount} accepted · {preview.rejectedCount} rejected</dd></div>
              <div><dt>Decisions</dt><dd>{Object.entries(preview.decisionCounts).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'None'}</dd></div>
              <div><dt>Score range</dt><dd>{preview.scoreRange ? `${preview.scoreRange.minimum}–${preview.scoreRange.maximum}` : 'No numeric scores'}</dd></div>
              {preview.stage === 'experience'
                ? <div><dt>Experience gate</dt><dd>Hard mismatches score 0 · scores below 70 dismiss</dd></div>
                : <div><dt>Evidence uncertainty</dt><dd>{preview.cannotEvaluateCount} cannot evaluate · {preview.doesNotMeetCount} affirmative conflicts</dd></div>}
              <div><dt>Safety</dt><dd>{preview.safeFailureCount} safe failures · {preview.protectedLifecycleCount} protected lifecycles</dd></div>
            </dl>
            <div className="scoring-preview-items" aria-label="Projected job decisions">
              {preview.projections.map((projection) => (
                <div key={projection.jobId} className="scoring-preview-item">
                  <div className="scoring-preview-item-summary">
                    <span><strong>{projection.company || 'Unknown company'}</strong> · {projection.title || 'Unknown title'}</span>
                    <span className="mono-value">#{projection.ordinal} · {projection.jobId}</span>
                    <strong>{projection.decision}{projection.score === null ? '' : ` · ${projection.score}${projection.band ? ` · ${projection.band}` : ''}`}</strong>
                    <span>{projection.detail}</span>
                    <span>{projection.currentStatus || 'unknown'} → {projection.proposedStatus || 'no transition'} · {projection.lifecycleAction === 'release_failed' ? 'score not imported; queue lease released' : projection.lifecycleAction === 'preserve_protected' ? 'protected status preserved' : 'transition will apply'}</span>
                    {projection.failurePermanence && <span>Failure: {projection.failurePermanence} · series {projection.failureSeriesOrdinal ?? 'pending'} · suppression {projection.suppressionActiveAfterApply ? 'active after apply' : 'not active after apply'}</span>}
                  </div>
                  {preview.stage === 'aim' ? <AimPreviewDetail assessment={projection.assessment} /> : (
                    <details className="scoring-preview-detail"><summary>Experience Fit responses</summary><pre>{JSON.stringify(projection.assessment, null, 2)}</pre></details>
                  )}
                </div>
              ))}
            </div>
            <div className="scoring-preview-actions">
              {approvalExpiresAt && <span className="log-help">Approval token expires {new Date(approvalExpiresAt).toLocaleString()}</span>}
              <button className="btn btn-secondary" onClick={() => setPreview(null)}>Close</button>
              {approvalToken && <button className="btn btn-danger" disabled={manualBusy} onClick={applyResult}>Approve {preview.acceptedCount} · Requeue {preview.safeFailureCount}</button>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
