'use client';

import React from 'react';
import { formatDistanceToNow, format, differenceInDays } from 'date-fns';
import { identifyAts, ATS_OPTIONS } from '@/lib/atsUtils';
import { showAlert } from '@/lib/modal';
import type { JobListItem } from '@/types/job';



interface JobCardProps {
  job: JobListItem;
  onSelect: (job: JobListItem) => void;
  primaryScore?: 'aim' | 'experience';
  onJobUpdate?: (jobId: string, updates: Partial<JobListItem>) => void;
  showAtsBadge?: boolean;
  isLucky?: boolean;
}

function JobCard({ job, onSelect, primaryScore = 'aim', onJobUpdate, showAtsBadge, isLucky }: JobCardProps) {
  const displayAsLucky = isLucky ?? Boolean(job.luckyStatus && job.luckyStatus !== 'none');
  const companyInitials = job.company
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  const updateJob = async (updates: Partial<JobListItem>) => {
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update the job.');
      if (onJobUpdate) onJobUpdate(job.id, data.job || updates);
    } catch(error) {
      console.error('Failed to update job', error);
      await showAlert(error instanceof Error ? error.message : 'Failed to update the job.');
    }
  };

  const isStale = job.postedAt && differenceInDays(new Date(), new Date(job.postedAt)) > 30;

  const getFitClass = () => {
    if (displayAsLucky && job.luckyStatus === 'inbox') return 'unicorn-job';

    const aimScore = displayAsLucky
      ? job.luckyAimFitScore
      : (job.aimFitScore ?? job.fitScore);
    if (aimScore == null && (displayAsLucky || job.reqFitScore == null)) return 'fit-pending';
    
    let expScore = job.reqFitScore ?? 0;
    if (displayAsLucky && job.luckyPassReason) {
      const match = job.luckyPassReason.match(/Experience Fit \((\d+)\/100\)/);
      if (match) expScore = parseInt(match[1], 10);
    }

    if (job.fitCategory === 'promoted') return 'fit-a'; // Keep promoted logic if applicable, though maybe just use score
    if (expScore >= 80) return 'fit-a';
    if (expScore >= 65) return 'fit-b';
    return 'fit-c';
  };

  const rawScore = displayAsLucky ? job.luckyAimFitScore : (job.aimFitScore ?? job.fitScore);
  const hasAimScore = rawScore != null;
  const score = rawScore ?? 0;
  const fitCategory = displayAsLucky ? job.luckyFitCategory : job.fitCategory;
  
  let luckyExpScore: number | null = job.reqFitScore ?? null;
  if (displayAsLucky && job.luckyPassReason) {
    const match = job.luckyPassReason.match(/Experience Fit \((\d+)\/100\)/);
    if (match) luckyExpScore = parseInt(match[1], 10);
  }
  const hasExperienceScore = luckyExpScore != null;
  const experienceScore = luckyExpScore ?? 0;
  
  let scoreColor = 'fill-red';
  if (fitCategory === 'rejected') scoreColor = 'fill-red';
  else if (score >= 80 || fitCategory === 'promoted') scoreColor = 'fill-green';
  else if (score >= 65) scoreColor = 'fill-amber';
  else if (!hasAimScore) scoreColor = 'fill-muted';

  const luckyBar = (
    <div className="score-row" key="lucky" style={{ marginTop: '0' }}>
      <span className="score-label">Wildcard Fit <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{job.luckyAimFitScore || 0}</span></span>
      <div className="score-track">
        <div className={`score-fill ${scoreColor}`} style={{ width: `${job.luckyAimFitScore || 0}%` }}></div>
      </div>
    </div>
  );

  const resumeBar = (
    <div className="score-row" key="resume" style={{ marginTop: primaryScore === 'aim' ? '0' : '6px' }}>
      <span className="score-label">Aim Fit <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{score}</span></span>
      <div className="score-track">
        <div className={`score-fill ${scoreColor}`} style={{ width: `${score}%` }}></div>
      </div>
    </div>
  );

  const expBar = (
    <div className="score-row" key="exp" style={{ marginTop: primaryScore === 'experience' ? '0' : '6px' }}>
      <span className="score-label">Experience Fit <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{hasExperienceScore ? luckyExpScore : 'Pending'}</span></span>
      <div className="score-track">
        <div
          className={`score-fill ${!hasExperienceScore ? 'fill-muted' : experienceScore >= 80 ? 'fill-green' : experienceScore >= 65 ? 'fill-amber' : 'fill-red'}`}
          style={{ width: `${experienceScore}%` }}
        ></div>
      </div>
    </div>
  );

  let travelColor = 'fill-purple';
  if (job.travelScore !== undefined && job.travelScore !== null) {
    if (job.travelScore <= 25) travelColor = 'fill-green';
    else if (job.travelScore <= 50) travelColor = 'fill-amber';
    else travelColor = 'fill-red';
  }

  const travelBar = job.travelScore !== undefined && job.travelScore !== null ? (
    <div className="score-row" key="travel" style={{ marginTop: '6px' }}>
      <span className="score-label">Travel Required <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{job.travelScore}</span></span>
      <div className="score-track">
        <div className={`score-fill ${travelColor}`} style={{ width: `${job.travelScore}%` }}></div>
      </div>
    </div>
  ) : null;

  return (
    <article
      className={`job-card ${getFitClass()}`}
      onClick={() => onSelect(job)}
    >
      <div className="card-identity">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {job.company && (
              <div className="company-mark" style={{ position: 'relative', padding: 0, overflow: 'hidden' }}>
                <span aria-hidden="true" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', margin: 0 }}>{companyInitials}</span>
                <img 
                  src={`https://www.google.com/s2/favicons?domain=${job.company.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}.com&sz=128`} 
                  alt=""
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain', background: 'white' }}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              </div>
            )}
            <div className="card-company">{job.company}</div>
          </div>
          {(job.status === 'applied' || job.status === 'interviewing') && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Applied {job.updatedAt ? format(new Date(job.updatedAt), 'MMM d, yyyy') : ''}
            </div>
          )}
        </div>
        <button
          type="button"
          className="card-title job-card-open"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(job);
          }}
          aria-label={`Open ${job.title} at ${job.company}`}
        >
          {job.title}
        </button>
      </div>
      
      <div className="score-bar">
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
          {job.status === 'passed' && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'var(--border2)' }}>
              🚫 Passed
            </div>
          )}
          {job.status === 'interviewing' && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#60a5fa', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(96, 165, 250, 0.15)' }}>
              🎙️ Interviewing
            </div>
          )}
          {showAtsBadge && (
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <select
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#eab308',
                  display: 'inline-block',
                  padding: '2px 20px 2px 8px',
                  borderRadius: '12px',
                  background: 'rgba(234, 179, 8, 0.1)',
                  border: 'none',
                  appearance: 'none',
                  cursor: 'pointer',
                  outline: 'none'
                }}
                value={job.manualAts || identifyAts(job)}
                onChange={(e) => updateJob({ manualAts: e.target.value })}
                onClick={(e) => e.stopPropagation()}
              >
                <option value={identifyAts(job)} disabled>⚙️ ATS: {identifyAts(job)}</option>
                {ATS_OPTIONS.map(r => <option key={r} value={r}>⚙️ ATS: {r}</option>)}
              </select>
              <div style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '8px', color: '#eab308' }}>▼</div>
            </div>
          )}
          {job.tailoringStaged && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#3b82f6', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(59, 130, 246, 0.1)' }}>
              ✂️ Tailoring
            </div>
          )}
        </div>
        {displayAsLucky ? (
          job.luckyAimFitScore == null ? (
            <div style={{ fontSize: '12px', color: 'var(--muted)', fontStyle: 'italic', padding: '4px 0' }}>
              Pending Wildcard Scoring...
            </div>
          ) : (
            [luckyBar, travelBar]
          )
        ) : (
          job.aimFitScore == null && job.reqFitScore == null && job.fitScore == null ? (
            <div style={{ fontSize: '12px', color: 'var(--muted)', fontStyle: 'italic', padding: '4px 0' }}>
              Pending AI Scoring...
            </div>
          ) : (
            (() => {
              const bars = primaryScore === 'aim' ? [resumeBar, expBar] : [expBar, resumeBar];
              return [...bars, travelBar];
            })()
          )
        )}
      </div>

      <div className="card-footer">
        <span className="card-location">{job.location || 'Location not provided'}</span>
        <span className="card-age" style={{ textAlign: 'right' }}>
          <div style={isStale ? { fontWeight: 'bold', color: '#800000' } : {}}>
            {job.source && `${job.source} • `}Posted {job.postedAt ? formatDistanceToNow(new Date(job.postedAt)) : '1d'} ago
          </div>
          <div style={{ opacity: 0.7 }}>In Dash: {job.createdAt ? formatDistanceToNow(new Date(job.createdAt)) : 'just now'}</div>
        </span>
      </div>
    </article>
  );
}

export default React.memo(JobCard);
