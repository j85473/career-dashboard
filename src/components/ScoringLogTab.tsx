'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { JobListItem } from '@/types/job';
import { showAlert, showConfirm } from '@/lib/modal';
import { MAX_SCORING_RUN_JOBS, SCORING_RUN_CHILD_BATCH_SIZE } from '@/lib/scoringLimits';
import {
  atsAcquisitionNote,
  atsAcquisitionStateLabel,
  atsThroughputLabel,
  atsWeekHealth,
  pipelineStatusRows,
  type PipelineStatusRow,
} from '@/lib/pipelineTelemetry';

type LogTab = 'action_needed' | 'local_scoring' | 'needs_jd' | 'aim_fit' | 'experience_fit' | 'context';

type ManualScoringBatch = {
  id: string;
  stage: 'aim' | 'experience';
  status: 'exported' | 'completed' | 'released' | 'superseded';
  createdAt: string;
  expiresAt: string;
  derivedExpired: boolean;
  exportHash: string;
  runId: string | null;
  _count: { items: number };
};

type ManualScoringRun = {
  id: string;
  stage: 'aim' | 'experience';
  status: 'exported' | 'completed' | 'released';
  createdAt: string;
  expiresAt: string;
  derivedExpired: boolean;
  exportHash: string;
  jobCount: number;
  batchCount: number;
  completedJobCount: number;
  completedBatchCount: number;
  blockedJobCount: number;
  blockedBatchCount: number;
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
  lifecycleAction?: 'apply' | 'preserve_protected' | 'action_needed';
  failurePermanence?: 'transient' | 'input_bound';
  failureSeriesOrdinal?: number;
  suppressionActiveAfterApply?: boolean;
};

type ImportPreview = {
  kind?: 'run';
  runId?: string;
  batchCount?: number;
  completedBatchCount?: number;
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

const count = (value: number) => value.toLocaleString('en-US');

function completionPercent(completed: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.min(100, Math.round((completed / total) * 100))}%`;
}

function PipelineStatusValue({ row }: { row: PipelineStatusRow }) {
  if (row.detail?.kind === 'ats-acquisition') {
    const detail = row.detail;
    const percent = detail.total > 0 ? Math.min(100, (detail.swept / detail.total) * 100) : 0;
    const lanePercent = detail.lanesTotal > 0
      ? Math.round((detail.lanesBusy / detail.lanesTotal) * 100)
      : 0;
    const week = atsWeekHealth(detail.weekCovered, detail.weekActive);
    return (
      <div className="pipeline-acquisition-detail">
        <div className="pipeline-rotation-head">
          <strong>{detail.rotationDay} rotation</strong>
          <span>{count(detail.swept)} / {count(detail.total)}</span>
          <strong>{completionPercent(detail.swept, detail.total)}</strong>
        </div>
        <div className="pipeline-rotation-track" role="presentation">
          <div className="pipeline-rotation-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className={`pipeline-acquisition-state state-${detail.state}`}>
          <strong>{atsAcquisitionStateLabel(detail.state)}</strong>
          <span>{atsAcquisitionNote(detail)}</span>
        </div>
        <div className="pipeline-acquisition-compute">
          <span>Lanes <strong>{detail.lanesBusy}/{detail.lanesTotal}</strong> ({lanePercent}%)</span>
          <span>{atsThroughputLabel(detail.boardsPerHour)}</span>
          <span className={`week-${week.tone}`}>{week.label}</span>
        </div>
      </div>
    );
  }
  if (row.detail?.kind === 'ats-stages') {
    const busy = row.detail.stages.filter((stage) => stage.value > 0);
    return (
      <div className="pipeline-stage-detail">
        {busy.length === 0 ? (
          <div className="pipeline-stage-clear">All stages clear — nothing queued downstream</div>
        ) : (
          <div className="pipeline-stage-grid">
            {busy.map((stage) => (
              <div className="pipeline-stage-cell" key={stage.id}>
                <span>{stage.label}</span>
                <strong>{count(stage.value)}</strong>
              </div>
            ))}
          </div>
        )}
        <div className="pipeline-flow-state">
          Flow control: <strong>{row.detail.flow}</strong>
          <span>Pause at {count(row.detail.pauseAt)} · resume at {count(row.detail.resumeAt)}</span>
        </div>
      </div>
    );
  }
  return <span className="pipeline-status-text">{row.value}</span>;
}

interface ScoringLogTabProps {
  onSelectJob?: (job: JobListItem) => void;
  activeLogTab: string;
  pipelineState?: {
    isRunning?: boolean;
    schedulePaused?: boolean;
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
  const runningStatusRows = pipelineStatusRows(pipelineState?.stepProgress);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [approvalExpiresAt, setApprovalExpiresAt] = useState<string | null>(null);
  const [resultPayload, setResultPayload] = useState<unknown>(null);
  const [batches, setBatches] = useState<ManualScoringBatch[]>([]);
  const [runs, setRuns] = useState<ManualScoringRun[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [importDragActive, setImportDragActive] = useState(false);

  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importDragDepthRef = useRef(0);

  const stage = currentTab === 'experience_fit' ? 'experience' : 'aim';
  const activeRun = runs.find((run) => run.stage === stage && run.status === 'exported') || null;
  const activeBatch = batches.find((batch) => batch.stage === stage && batch.runId === null
    && (batch.status === 'exported' || batch.status === 'superseded')) || null;

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

  const fetchRuns = useCallback(async () => {
    if (currentTab !== 'aim_fit' && currentTab !== 'experience_fit') return;
    setBatchesLoading(true);
    try {
      const response = await fetch(`/api/scoring/runs?stage=${stage}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load scoring runs.');
      setRuns(body.runs || []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load scoring runs.');
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
      anchor.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
        || (stage === 'aim' ? `START-AIM-FIT-${batchId}.json` : `START-E-FIT-${batchId}.json`);
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Exact batch download failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const downloadStoredRun = async (runId: string) => {
    setManualBusy(true);
    try {
      const response = await fetch(`/api/scoring/runs/${runId}/download`, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Exact run download failed.');
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
        || (stage === 'aim' ? `START-AIM-FIT-RUN-${runId}.json` : `START-E-FIT-RUN-${runId}.json`);
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Exact run download failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const extendRun = async (run: ManualScoringRun) => {
    const base = Math.max(Date.now(), new Date(run.expiresAt).valueOf());
    const expiresAt = new Date(base + 24 * 60 * 60 * 1000).toISOString();
    if (!await showConfirm(`Extend exact run ${run.id} and all pending child batches by 24 hours?`)) return;
    setManualBusy(true);
    try {
      const response = await fetch(`/api/scoring/runs/${run.id}/extend`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresAt }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Run extension failed.');
      await fetchRuns();
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Run extension failed.');
    } finally {
      setManualBusy(false);
    }
  };

  const releaseRun = async (run: ManualScoringRun) => {
    const completed = run.completedBatchCount > 0
      ? ` ${run.completedBatchCount} completed child batch(es) and their accepted scores will remain unchanged.`
      : '';
    if (!await showConfirm(
      `Release the ${run.jobCount - run.completedJobCount} remaining leases in run ${run.id}?${completed} Pending result children will no longer be importable.`,
      'Release Remaining Run',
      'Keep Run',
    )) return;
    setManualBusy(true);
    try {
      const response = await fetch(`/api/scoring/runs/${run.id}/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Run release failed.');
      setPreview(null); setApprovalToken(null); setApprovalExpiresAt(null); setResultPayload(null);
      await Promise.all([fetchRuns(), fetchBatches(), fetchJobs(1, false, true)]);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Run release failed.');
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
      const response = await fetch('/api/scoring/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Scoring export failed.');
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
        || (stage === 'aim' ? 'START-AIM-FIT-RUN.json' : 'START-E-FIT-RUN.json');
      anchor.click();
      URL.revokeObjectURL(href);
      await Promise.all([fetchRuns(), fetchBatches(), fetchJobs(1, false, true)]);
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Scoring export failed.');
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

  const selectImportFile = async (files: FileList | File[]) => {
    if (manualBusy || files.length === 0) return;
    if (files.length !== 1) {
      await showAlert('Drop one scoring result JSON file at a time.');
      return;
    }

    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.json')) {
      await showAlert('The scoring result must be a .json file.');
      return;
    }

    await previewResult(file);
  };

  const handleImportDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (manualBusy) return;
    importDragDepthRef.current += 1;
    setImportDragActive(true);
  };

  const handleImportDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (manualBusy) return;
    importDragDepthRef.current = Math.max(0, importDragDepthRef.current - 1);
    if (importDragDepthRef.current === 0) setImportDragActive(false);
  };

  const handleImportDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    importDragDepthRef.current = 0;
    setImportDragActive(false);
    if (manualBusy) return;
    void selectImportFile(event.dataTransfer.files);
  };

  const applyResult = async () => {
    if (!approvalToken || !resultPayload || !preview) return;
    const failureAction = `send ${preview.safeFailureCount} unscored job(s) to Action Needed`;
    const applyDetail = preview.kind === 'run'
      ? ` Import is atomic per ${SCORING_RUN_CHILD_BATCH_SIZE}-job child; if a later child fails, earlier children remain applied and the run can be re-previewed and resumed.`
      : '';
    if (!await showConfirm(`Import ${preview.acceptedCount} validated result(s) and ${failureAction}?${applyDetail}`)) return;
    setManualBusy(true);
    try {
      const response = await fetch('/api/scoring/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'apply', payload: resultPayload, approvalToken }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Scoring import failed.');
      setPreview(null); setApprovalToken(null); setApprovalExpiresAt(null); setResultPayload(null);
      await showAlert(`Imported ${body.imported} ${stage} result(s); sent ${body.released || 0} unscored job(s) to Action Needed.${body.completedBatches ? ` Completed ${body.completedBatches} child batches.` : ''}`);
      await Promise.all([fetchJobs(1, false, true), fetchRuns(), fetchBatches()]);
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
        sort: currentTab === 'aim_fit' ? 'aim_priority' : 'newest',
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
    const timer = setTimeout(() => { void fetchRuns(); }, 0);
    return () => clearTimeout(timer);
  }, [fetchRuns]);

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
              <p>{pagination.total} active jobs could not be scored automatically and need your attention.</p>
            </div>
          </section>
          <p className="log-help">Only unrecoverable JD and Aim or Experience Fit scoring failures stay here. Closed postings are dismissed.</p>
          <div className="log-list">
            {jobs.length ? jobs.map((job) => row(job, (
              <em>
                {job.scoreError || (job.scoringStatus === 'scored'
                  ? 'Aim Fit could not score this job.'
                  : `${job.scoringStatus || 'unknown state'} · ${job.scoreAttempts || 0} attempts`)}
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
              <p>{queued.length} jobs are waiting for job-description recovery (ATS API first, Jina fallback).</p>
            </div>
            <button className="btn btn-primary" disabled={pipelineState?.isRunning || queued.length === 0} onClick={() => startPipeline('/api/pipeline/extraction')}>
              {pipelineState?.isRunning ? 'Pipeline running…' : 'Run extraction'}
            </button>
          </section>
          {processing.length > 0 && (
            <section style={{ background: 'rgba(0,111,255,0.05)', border: '1px solid rgba(0, 111, 255, 0.2)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
              <div className="section-label" style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <div className="ticker-pulse" style={{ display: 'inline-block' }}></div>
                JD recovery is currently processing
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
              <p>{pagination.total} ready job(s) are visible in this stage. Each export reserves up to {MAX_SCORING_RUN_JOBS} jobs; remaining jobs stay ready for the next batch. Codex runs outside the Dashboard.</p>
              <span className="scoring-calibration-badge">
                {stage === 'aim'
                  ? 'Aim v2 · complete-source facts · deterministic score'
                  : 'Hard requirements gate qualification · score ranks qualified survivors only'}
              </span>
              <span className="scoring-calibration-badge">
                Independent run · {SCORING_RUN_CHILD_BATCH_SIZE}-job recoverable children · bounded concurrency
              </span>
              <span className="log-help">Upload always previews the complete run first. Import applies children atomically and sends every unscored job to Action Needed.</span>
              {batchesLoading ? <span className="log-help">Loading scoring lease…</span> : activeRun ? (
                <dl className="manual-scoring-grid" aria-label="Active scoring run">
                  <div><dt>Active run</dt><dd className="mono-value">{activeRun.id}</dd></div>
                  <div><dt>Status</dt><dd>{activeRun.blockedBatchCount > 0 ? 'Blocked child · release remaining run' : activeRun.derivedExpired ? 'Expired · still reserved' : activeRun.completedBatchCount > 0 ? 'Partially applied' : activeRun.status}</dd></div>
                  <div><dt>Age</dt><dd>{formatAge(activeRun.createdAt)}</dd></div>
                  <div><dt>Reserved</dt><dd>{activeRun.jobCount} jobs in {activeRun.batchCount} child batches</dd></div>
                  <div><dt>Applied</dt><dd>{activeRun.completedJobCount} jobs · {activeRun.completedBatchCount}/{activeRun.batchCount} children</dd></div>
                  {activeRun.blockedBatchCount > 0 && <div><dt>Blocked</dt><dd>{activeRun.blockedJobCount} jobs · {activeRun.blockedBatchCount} unavailable child batch(es)</dd></div>}
                  <div><dt>Expiry</dt><dd>{new Date(activeRun.expiresAt).toLocaleString()}</dd></div>
                </dl>
              ) : activeBatch ? (
                <dl className="manual-scoring-grid" aria-label="Active scoring batch">
                  <div><dt>Active batch</dt><dd className="mono-value">{activeBatch.id}</dd></div>
                  <div><dt>Status</dt><dd>{activeBatch.derivedExpired ? 'Expired · still leased' : activeBatch.status}</dd></div>
                  <div><dt>Age</dt><dd>{formatAge(activeBatch.createdAt)}</dd></div>
                  <div><dt>Members</dt><dd>{activeBatch._count.items}</dd></div>
                  <div><dt>Expiry</dt><dd>{new Date(activeBatch.expiresAt).toLocaleString()}</dd></div>
                </dl>
              ) : <span className="log-help">No active {stage} run or legacy batch lease.</span>}
            </div>
            <div className="log-action-column">
              <div className="log-action-buttons">
                {!activeRun && !activeBatch && <button className="btn btn-primary" disabled={manualBusy || pagination.total === 0} onClick={downloadExport}>{manualBusy ? 'Working…' : `Export Batch (max ${MAX_SCORING_RUN_JOBS})`}</button>}
                {activeRun && <button className="btn btn-secondary" disabled={manualBusy} onClick={() => downloadStoredRun(activeRun.id)}>Exact run re-download</button>}
                {activeRun && <button className="btn btn-secondary" disabled={manualBusy} onClick={() => extendRun(activeRun)}>Extend 24h</button>}
                {activeRun && <button className="btn btn-danger" disabled={manualBusy} onClick={() => releaseRun(activeRun)}>Release remaining run</button>}
                {!activeRun && activeBatch && <button className="btn btn-secondary" disabled={manualBusy} onClick={() => downloadStoredBatch(activeBatch.id)}>Exact legacy re-download</button>}
                {!activeRun && activeBatch?.status === 'exported' && <button className="btn btn-secondary" disabled={manualBusy} onClick={() => extendBatch(activeBatch)}>Extend 24h</button>}
                {!activeRun && activeBatch && <button className="btn btn-danger" disabled={manualBusy} onClick={() => releaseBatch(activeBatch)}>Release legacy batch</button>}
              </div>
              <div
                className={`scoring-import-dropzone${importDragActive ? ' is-dragging' : ''}${manualBusy ? ' is-disabled' : ''}`}
                role="button"
                tabIndex={manualBusy ? -1 : 0}
                aria-disabled={manualBusy}
                aria-label={`Import ${stage === 'aim' ? 'Aim Fit' : 'Experience Fit'} scoring result JSON`}
                onClick={() => { if (!manualBusy) importInputRef.current?.click(); }}
                onKeyDown={(event) => {
                  if (!manualBusy && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    importInputRef.current?.click();
                  }
                }}
                onDragEnter={handleImportDragEnter}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = manualBusy ? 'none' : 'copy';
                }}
                onDragLeave={handleImportDragLeave}
                onDrop={handleImportDrop}
              >
                <span className="scoring-import-dropzone-icon" aria-hidden="true">⇩</span>
                <span>
                  <strong>{manualBusy ? 'Working…' : 'Drop result JSON here'}</strong>
                  <small>or click to choose a file</small>
                </span>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  disabled={manualBusy}
                  onChange={(event) => {
                    if (event.target.files) void selectImportFile(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />
              </div>
            </div>
          </section>
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
          <div className="pipeline-running-status">
            <div className="pipeline-status-panel" aria-live="polite">
              <div className="pipeline-status-heading">
                <span className="ticker-pulse" aria-hidden="true"></span>
                <strong>{pipelineState.currentStep}</strong>
                <span className="pipeline-status-total">{pagination.total} total</span>
                <button className="btn btn-danger" onClick={() => startPipeline('/api/pipeline/stop')}>Stop</button>
              </div>
              <dl className="pipeline-status-rows">
                {runningStatusRows.map((row) => (
                  <div className={`pipeline-status-row pipeline-status-row--${row.id}`} key={row.id}>
                    <dt>{row.label}</dt>
                    <dd><PipelineStatusValue row={row} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        ) : pipelineState?.schedulePaused ? (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div className="pipeline-chip" aria-live="polite">
              <strong>Paused</strong>
              <span>{pipelineState.stepProgress}</span>
            </div>
            <button className="btn btn-primary" onClick={() => startPipeline('/api/pipeline/run')}>Resume full pipeline</button>
          </div>
        ) : pipelineState?.currentStep === 'Error' || pipelineState?.currentStep === 'Warning' ? (
          <div className="pipeline-chip" role="alert">
            <strong>{pipelineState.currentStep}</strong>
            <span>{pipelineState.stepProgress}</span>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={() => startPipeline('/api/pipeline/run')}>Run full pipeline</button>
        )}
        {!pipelineState?.isRunning && <span className="result-count">{pagination.total} total</span>}
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
                <h2 id="scoring-preview-title">Zero-write {preview.stage === 'aim' ? 'Aim' : 'Experience'} {preview.kind === 'run' ? 'run' : 'batch'} preview</h2>
                <p className="log-help mono-value">{preview.runId || preview.batchId}</p>
              </div>
              <button className="expand-close" aria-label="Close preview" onClick={() => setPreview(null)}>✕</button>
            </div>
            <div className={`scoring-preview-verdict ${preview.applicable ? 'applicable' : 'blocked'}`}>
              <strong>{preview.applicable
                ? `${preview.acceptedCount} result(s) ready · ${preview.safeFailureCount} unscored job(s) go to Action Needed`
                : 'Blocked — result contract is invalid'}</strong>
              <span>This preview made no database writes.</span>
            </div>
            <dl className="manual-scoring-grid scoring-preview-summary">
              <div><dt>Membership</dt><dd>{preview.suppliedCount} supplied / {preview.expectedCount} expected</dd></div>
              {preview.kind === 'run' && <div><dt>Child batches</dt><dd>{preview.completedBatchCount || 0} completed / {preview.batchCount || 0} total</dd></div>}
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
                    <span>{projection.currentStatus || 'unknown'} → {projection.proposedStatus || 'no transition'} · {projection.lifecycleAction === 'action_needed' ? 'score not imported; sent to Action Needed' : projection.lifecycleAction === 'preserve_protected' ? 'protected status preserved' : 'transition will apply'}</span>
                    {projection.failurePermanence && <span>Failure: {projection.failurePermanence} · series {projection.failureSeriesOrdinal ?? 'pending'}</span>}
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
              {approvalToken && <button className="btn btn-danger" disabled={manualBusy} onClick={applyResult}>Import {preview.kind === 'run' ? 'Run' : 'Batch'}</button>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
