'use client';

import React, { useState, useEffect } from 'react';
import JobCard from './JobCard';

export function ScoringLogTab({ onSelectJob, activeLogTab }: { onSelectJob?: (job: any) => void, activeLogTab: string }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [processing, setProcessing] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

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

  const handleProcessQueue = async () => {
    const controller = new AbortController();
    setAbortController(controller);
    setProcessing(true);
    try {
      const res = await fetch('/api/jobs/search?onlyScore=true', { 
        method: 'POST',
        signal: controller.signal
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let buffer = '';

      while (!done && reader) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n\n')) >= 0) {
            const eventStr = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 2);
            if (eventStr.startsWith('data: ')) {
              try {
                const data = JSON.parse(eventStr.slice(6));
                if (data.step === 'scoring_job' && data.job) {
                  // Mark this job as currently scoring in UI immediately
                  setJobs(prev => prev.map(j => j.id === data.job.id ? { ...j, scoringStatus: 'scoring' } : j));
                } else if (data.step === 'scored' && data.job) {
                  // Remove from queue when scored
                  setJobs(prev => prev.filter(j => j.id !== data.job.id));
                } else if (data.step === 'done') {
                  setProcessing(false);
                  fetchJobs();
                }
              } catch(e) {}
            }
          }
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        console.log('Processing canceled.');
      } else {
        console.error('Processing failed', e);
      }
    }
    setProcessing(false);
    setAbortController(null);
  };

  // handleProcessJdQueue removed since we use batch endpoints now


  const cancelProcess = () => {
    if (abortController) {
      abortController.abort();
    }
  };

  const failed = jobs.filter(j => j.scoringStatus === 'failed' && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const skipped = jobs.filter(j => j.scoringStatus === 'skipped' && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const needsJdQueued = jobs.filter(j => j.scoringStatus === 'needs_jd' && j.jdBatchId === null && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const needsJdProcessing = jobs.filter(j => j.jdBatchId !== null && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const queued = jobs.filter(j => (j.scoringStatus === 'queued' || j.scoringStatus === 'scoring') && !['passed', 'dismissed', 'applied', 'archived'].includes(j.status));
  const experienceQueued = jobs.filter(j => j.experienceStatus === 'queued' && j.scoringStatus === 'scored' && j.reqFitScore === null && !['dismissed', 'applied', 'archived'].includes(j.status));
  const experienceProcessing = jobs.filter(j => j.experienceStatus === 'processing' && !['dismissed', 'applied', 'archived'].includes(j.status));

  const reviewJobs = jobs.filter(j => j.fitCategory === 'review');
  const contextQueued = jobs.filter(j => (j.status === 'passed' || j.status === 'applied') && j.contextBatched === false);
  const aimFitQueued = jobs.filter(j => j.status === 'pending_af' && j.scoringStatus === 'scored' && !j.afBatchId);
  const aimFitProcessing = jobs.filter(j => j.status === 'pending_af' && j.afBatchId);

  return (
    <div style={{ padding: '0 28px', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>

        
        {activeLogTab === 'queue' && (
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-primary" onClick={handleRetryFailed} disabled={(failed.length === 0 && skipped.length === 0) || processing}>
              Retry Failed ({failed.length + skipped.length})
            </button>
            {processing ? (
              <button className="btn btn-danger" onClick={cancelProcess}>
                Cancel Process
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleProcessQueue} disabled={queued.length === 0}>
                Process Queue ({queued.length})
              </button>
            )}
          </div>
        )}

        {activeLogTab === 'needs_jd' && (
          <div style={{ display: 'flex', gap: '12px' }}>
            {processing ? (
              <button className="btn btn-danger" onClick={cancelProcess}>
                Cancel
              </button>
            ) : (
              <>
                <button className="btn btn-primary" onClick={async () => {
                  setProcessing(true);
                  try {
                    await fetch('/api/jobs/batch-jd-submit', { method: 'POST' });
                    fetchJobs();
                  } catch(e){}
                  setProcessing(false);
                }} disabled={needsJdQueued.length === 0}>
                  Process Jina
                </button>
                <button className="btn btn-outline" onClick={async () => {
                  setProcessing(true);
                  try {
                    const res = await fetch('/api/jobs/batch-jd-status');
                    const data = await res.json();
                    
                    if (data.message === 'JD Status check complete' && data.processedCount > 0) {
                      alert(`Batch processing complete! Successfully pulled ${data.processedCount} JDs.`);
                    } else if (data.message === 'No JD batches currently processing on Gemini API.' && data.pendingCount > 0) {
                      alert(`There are ${data.pendingCount} jobs currently being processed locally via the Jina API to extract markdown. Once this finishes, the batch will be submitted to Gemini. Please wait a bit longer!`);
                    } else if (data.message === 'JD Status check complete' && data.processedCount === 0) {
                      alert(`Batch is still processing. Please check again in a few minutes.`);
                    } else if (data.message) {
                      alert(data.message);
                    }
                    
                    fetchJobs();
                  } catch(e) {
                    alert('Failed to check batch status. Check server logs.');
                  }
                  setProcessing(false);
                }} disabled={needsJdProcessing.length === 0}>
                  Check Batch Status
                </button>
              </>
            )}
          </div>
        )}

        {activeLogTab === 'context' && (
          <div style={{ display: 'flex', gap: '12px' }}>
            {processing ? (
              <button className="btn btn-danger" onClick={cancelProcess}>
                Cancel
              </button>
            ) : (
              <>
                <button className="btn btn-primary" onClick={async () => {
                  setProcessing(true);
                  try {
                    await fetch('/api/jobs/batch-context', { method: 'POST' });
                    fetchJobs();
                  } catch(e){}
                  setProcessing(false);
                }} disabled={contextQueued.length === 0}>
                  Update Context DB ({contextQueued.length})
                </button>
                <button className="btn btn-outline" onClick={async () => {
                  setProcessing(true);
                  try {
                    const res = await fetch('/api/jobs/batch-context-status');
                    const data = await res.json();
                    alert(data.message || 'Status check complete.');
                    fetchJobs();
                  } catch(e){
                    alert('Failed to check batch status. Check server logs.');
                  }
                  setProcessing(false);
                }}>
                  Check Batch Status
                </button>
              </>
            )}
          </div>
        )}

        {activeLogTab === 'aim_fit' && (
          <div style={{ display: 'flex', gap: '12px' }}>
            {processing ? (
              <button className="btn btn-danger" onClick={cancelProcess}>
                Cancel
              </button>
            ) : (
              <>
                <button className="btn btn-primary" onClick={async () => {
                  setProcessing(true);
                  try {
                    await fetch('/api/jobs/batch-af', { method: 'POST' });
                    fetchJobs();
                  } catch(e){}
                  setProcessing(false);
                }} disabled={aimFitQueued.length === 0}>
                  Submit A/E Fit Batch ({aimFitQueued.length})
                </button>
                <button className="btn btn-outline" onClick={async () => {
                  setProcessing(true);
                  try {
                    const res = await fetch('/api/jobs/batch-af-status');
                    const data = await res.json();
                    if (data.message === 'Status check complete' && data.processedCount > 0) {
                      alert(`Batch processing complete! Successfully evaluated ${data.processedCount} jobs.`);
                    } else if (data.message === 'Status check complete' && data.processedCount === 0) {
                      alert(`Batch is still processing. Please check again in a few minutes.`);
                    } else if (data.message) {
                      alert(data.message);
                    }
                    fetchJobs();
                  } catch(e){
                    alert('Failed to check batch status. Check server logs.');
                  }
                  setProcessing(false);
                }} disabled={aimFitProcessing.length === 0}>
                  Check Batch Status ({aimFitProcessing.length})
                </button>
              </>
            )}
          </div>
        )}
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
          <div>
            <div className="section-label" style={{ color: 'var(--blue)' }}>Processing in AF Batch ({aimFitProcessing.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {aimFitProcessing.length === 0 && <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No AF batches currently processing.</div>}
              {aimFitProcessing.map(job => (
                <div key={job.id} className="log-job-row" onClick={() => onSelectJob?.(job)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{job.company}</div>
                    <div style={{ color: 'var(--muted)' }}>{job.title}</div>
                    <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--blue)' }}>AF Batch Job ID: {job.afBatchId}</div>
                  </div>
                  <svg width="24" height="24" viewBox="0 0 24 24" className="progress-ring-svg">
                    <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.1)" strokeWidth="3" fill="none" />
                    <circle cx="12" cy="12" r="10" stroke="var(--blue)" strokeWidth="3" fill="none" strokeDasharray="62.8" strokeDashoffset="62.8" className="progress-ring-circle" strokeLinecap="round" />
                  </svg>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : activeLogTab === 'queue' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          <div>
            <div className="section-label" style={{ color: 'var(--accent)' }}>Queued ({queued.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {queued.length === 0 && <div style={{ color: 'var(--muted)', fontSize: '13px' }}>Queue is empty.</div>}
              {queued.map(job => (
                <div key={job.id} className="log-job-row" onClick={() => onSelectJob?.(job)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 16px', borderRadius: '8px', fontSize: '13px' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{job.company}</div>
                    <div style={{ color: 'var(--muted)' }}>{job.title}</div>
                    <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--accent)' }}>Status: {job.scoringStatus.toUpperCase()}</div>
                  </div>
                  {job.scoringStatus === 'scoring' && (
                    <svg width="24" height="24" viewBox="0 0 24 24" className="progress-ring-svg">
                      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.1)" strokeWidth="3" fill="none" />
                      <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="3" fill="none" strokeDasharray="62.8" strokeDashoffset="62.8" className="progress-ring-circle" strokeLinecap="round" />
                    </svg>
                  )}
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
