'use client';

import React, { useState, useEffect } from 'react';
import JobCard from './JobCard';

export function ScoringLogTab({ onSelectJob, activeLogTab, pipelineState }: { onSelectJob?: (job: any) => void, activeLogTab: string, pipelineState?: any }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isEvaluating, setIsEvaluating] = useState(false);

  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/jobs?status=log');
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 5000); // refresh every 5 seconds for snappier UI
    
    const handleJobUpdate = (e: any) => {
      const { id, status } = e.detail;
      if (status === 'passed' || status === 'dismissed' || status === 'promoted' || status === 'inbox') {
        setJobs(prev => prev.filter(j => j.id !== id));
      }
    };
    window.addEventListener('jobStatusChanged', handleJobUpdate);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('jobStatusChanged', handleJobUpdate);
    };
  }, []);

  const handleRetryFailed = async () => {
    try {
      await fetch('/api/jobs/retry', { method: 'POST' });
      fetchJobs();
    } catch (e) {
      console.error(e);
    }
  };



  // Legacy queue handlers removed.

  const failed = jobs.filter(j => j.scoringStatus === 'failed' && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const skipped = jobs.filter(j => j.scoringStatus === 'skipped' && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const needsJdQueued = jobs.filter(j => j.scoringStatus === 'needs_jd' && j.jdBatchId === null && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const needsJdProcessing = jobs.filter(j => j.jdBatchId !== null && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));

  const experienceQueued = jobs.filter(j => j.experienceStatus === 'queued' && j.scoringStatus === 'scored' && j.reqFitScore === null && !['dismissed', 'applied', 'archived'].includes(j.status));
  const experienceProcessing = jobs.filter(j => j.experienceStatus === 'processing' && !['dismissed', 'applied', 'archived'].includes(j.status));

  const reviewJobs = jobs.filter(j => j.fitCategory === 'review');
  const contextQueued = jobs.filter(j => (j.status === 'passed' || j.status === 'applied') && j.contextBatched === false);
  const aimFitQueued = jobs.filter(j => (j.status === 'pending_af' || j.status === 'inbox') && j.scoringStatus === 'scored' && !j.afBatchId && j.aimFitScore === null);


  return (
    <div style={{ padding: '0 28px', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {pipelineState?.isRunning ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--surface)', padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" className="progress-ring-svg">
                <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.1)" strokeWidth="3" fill="none" />
                <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="3" fill="none" strokeDasharray="62.8" strokeDashoffset="62.8" className="progress-ring-circle" strokeLinecap="round" />
              </svg>
              <div>
                <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--accent)' }}>Pipeline Running: {pipelineState.currentStep}</div>
                <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{pipelineState.stepProgress}</div>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={async () => {
              await fetch('/api/pipeline/run', { method: 'POST' });
            }}>
              Run Full Pipeline
            </button>
          )}
        </div>
      </div>


      {loading && jobs.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>Loading...</div>
      ) : activeLogTab === 'review' ? (
        <div className="job-grid" style={{ marginTop: '24px' }}>
          {reviewJobs.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No jobs pending review.</div>
          ) : (
            reviewJobs.map(job => (
              <JobCard key={job.id} job={job} onClick={() => onSelectJob && onSelectJob(job)} />
            ))
          )}
        </div>
      ) : activeLogTab === 'needs_jd' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '24px' }}>
          <div>
            <div className="section-label" style={{ color: 'var(--accent)' }}>Queued for Jina Extraction ({needsJdQueued.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {needsJdQueued.length === 0 && <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No truncated jobs waiting.</div>}
              {needsJdQueued.map(job => (
                <div key={job.id} className="log-job-row" onClick={() => onSelectJob?.(job)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{job.company}</div>
                    <div style={{ color: 'var(--muted)' }}>{job.title}</div>
                    {job.scoreError && <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--red)' }}>{job.scoreError}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          {needsJdProcessing.length > 0 && (
            <div>
              <div className="section-label" style={{ color: 'var(--accent)' }}>Jina Extraction & Batch Processing ({needsJdProcessing.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {needsJdProcessing.map(job => (
                  <div key={job.id} className="log-job-row processing" onClick={() => onSelectJob?.(job)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface)', border: '1px dashed var(--border)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px', opacity: 0.8 }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{job.company}</div>
                      <div style={{ color: 'var(--muted)' }}>{job.title}</div>
                    </div>
                    <svg width="24" height="24" viewBox="0 0 24 24" className="progress-ring-svg">
                      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.1)" strokeWidth="3" fill="none" />
                      <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="3" fill="none" strokeDasharray="62.8" strokeDashoffset="62.8" className="progress-ring-circle" strokeLinecap="round" />
                    </svg>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

      ) : activeLogTab === 'context' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '24px' }}>
          <div>
            <div className="section-label" style={{ color: 'var(--accent)' }}>Queued for Context DB Update ({contextQueued.length})</div>
            <div style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '16px' }}>
              Context updates are processed automatically during the next DeepSeek A/E Fit Evaluation batch.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {contextQueued.length === 0 && <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No jobs waiting for context update.</div>}
              {contextQueued.map(job => (
                <div key={job.id} className="log-job-row" onClick={() => onSelectJob?.(job)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{job.company}</div>
                    <div style={{ color: 'var(--muted)' }}>{job.title}</div>
                    <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--accent)' }}>Status: {job.status.toUpperCase()}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : activeLogTab === 'aim_fit' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '24px' }}>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: 'var(--surface)', padding: '20px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text)', marginBottom: '4px' }}>Native DeepSeek Evaluation</div>
                <div style={{ fontSize: '13px', color: 'var(--muted)' }}>
                  This will evaluate all {aimFitQueued.length} queued A/E Fit jobs directly via the DeepSeek API.
                </div>
              </div>
              <button 
                className="btn btn-primary" 
                disabled={pipelineState?.isRunning || aimFitQueued.length === 0}
                style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', minWidth: '200px', justifyContent: 'center' }}
                onClick={async () => {
                  try {
                    await fetch('/api/pipeline/deepseek', { method: 'POST' });
                  } catch(e: any) {
                    alert(`Failed to start: ${e.message}`);
                  }
                }}
              >
                {pipelineState?.isRunning ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" className="spin">
                      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.2)" strokeWidth="3" fill="none" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
                    </svg>
                    Pipeline Running...
                  </>
                ) : (
                  <>🚀 Run Evaluation Now</>
                )}
              </button>
            </div>
          </div>

          <div>
            <div className="section-label" style={{ color: 'var(--accent)' }}>Queued for A/E Fit Batch ({aimFitQueued.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {aimFitQueued.length === 0 && <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No jobs waiting for A/E Fit processing.</div>}
              {aimFitQueued.map(job => (
                <div key={job.id} className="log-job-row" onClick={() => onSelectJob?.(job)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{job.company}</div>
                    <div style={{ color: 'var(--muted)' }}>{job.title}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : activeLogTab === 'graveyard' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '24px' }}>
          <div>
            <div className="section-label" style={{ color: 'var(--red)' }}>Failed / Skipped ({failed.length + skipped.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {failed.length === 0 && skipped.length === 0 && <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No failed jobs.</div>}
              {[...failed, ...skipped].map(job => (
                <div key={job.id} className="log-job-row" onClick={() => onSelectJob?.(job)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px' }}>
                  <div style={{ fontWeight: 600 }}>{job.company}</div>
                  <div style={{ color: 'var(--muted)' }}>{job.title}</div>
                  <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--red)' }}>
                    Error: {job.scoreError || 'Unknown timeout'} (Attempts: {job.scoreAttempts})
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
