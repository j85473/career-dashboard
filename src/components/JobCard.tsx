'use client';

import React from 'react';
import { formatDistanceToNow, format, differenceInDays } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { identifyAts, ATS_OPTIONS } from '@/lib/atsUtils';
import { showAlert } from '@/lib/modal';
import type { JobListItem } from '@/types/job';
import { isPromptHealthPriorityRole, PROMPT_HEALTH_PRIORITY_BANNER } from '@/lib/priorityOpportunity';
import { travelOpportunityFill, travelOpportunityTier } from '@/lib/travelOpportunity';



interface JobCardProps {
  job: JobListItem;
  onSelect: (job: JobListItem) => void;
  primaryScore?: 'aim' | 'experience';
  onJobUpdate?: (jobId: string, updates: Partial<JobListItem>) => void;
  showAtsBadge?: boolean;
  showStatusBadge?: boolean;
}
function JobCard({ job, onSelect, primaryScore = 'aim', onJobUpdate, showStatusBadge = false }: JobCardProps) {
  const isPromptHealthPriority = isPromptHealthPriorityRole(job);
  const hasCurrentScoreAuthority = job.scoreAuthorityState === 'current';
  const scoreReplayNeeded = job.scoreAuthorityState === 'stale_replay_needed';
  const isHumanPromoted = /^Promoted by user:/i.test(job.passReason || '');
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
    if (scoreReplayNeeded) return 'fit-pending';
    if (isHumanPromoted) return 'fit-a';
    const aimScore = hasCurrentScoreAuthority ? job.aimFitScore : null;
    const authoritativeExperience = hasCurrentScoreAuthority ? job.reqFitScore : null;
    if (aimScore == null && authoritativeExperience == null) return 'fit-pending';
    
    const expScore = authoritativeExperience ?? 0;

    if (expScore >= 80) return 'fit-a';
    if (expScore >= 65) return 'fit-b';
    return 'fit-c';
  };

  const rawScore = hasCurrentScoreAuthority ? job.aimFitScore : null;
  const hasAimScore = rawScore != null;
  const score = rawScore ?? 0;
  const experienceFitScore: number | null = hasCurrentScoreAuthority ? job.reqFitScore ?? null : null;
  const hasExperienceScore = experienceFitScore != null;
  const experienceScore = experienceFitScore ?? 0;
  
  let scoreColor = 'fill-red';
  if (score >= 80) scoreColor = 'fill-green';
  else if (score >= 65) scoreColor = 'fill-amber';
  else if (!hasAimScore) scoreColor = 'fill-muted';

  const resumeBar = (
    <div className="score-row" key="resume" style={{ marginTop: primaryScore === 'aim' ? '0' : '6px' }}>
      <span className="score-label">Aim Fit <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{hasAimScore ? score : 'Pending'}</span></span>
      <div className="score-track">
        <div className={`score-fill ${scoreColor}`} style={{ width: `${score}%` }}></div>
      </div>
    </div>
  );

  const expBar = (
    <div className="score-row" key="exp" style={{ marginTop: primaryScore === 'experience' ? '0' : '6px' }}>
      <span className="score-label">Experience Fit <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{hasExperienceScore ? experienceFitScore : 'Pending'}</span></span>
      <div className="score-track">
        <div
          className={`score-fill ${!hasExperienceScore ? 'fill-muted' : experienceScore >= 80 ? 'fill-green' : experienceScore >= 65 ? 'fill-amber' : 'fill-red'}`}
          style={{ width: `${experienceScore}%` }}
        ></div>
      </div>
    </div>
  );

  const authoritativeTravelScore = hasCurrentScoreAuthority ? job.travelScore : null;
  const travelColor = travelOpportunityFill(authoritativeTravelScore);
  const travelTier = travelOpportunityTier(authoritativeTravelScore);

  const travelBar = authoritativeTravelScore !== null ? (
    <div className="score-row" key="travel" style={{ marginTop: '6px' }}>
      <span className="score-label">Travel Opportunity <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{authoritativeTravelScore}</span></span>
      <div className="score-track">
        <div className={`score-fill ${travelColor}`} style={{ width: `${authoritativeTravelScore}%` }}></div>
      </div>
    </div>
  ) : null;

  return (
    <article
      className={`job-card ${getFitClass()}${isPromptHealthPriority ? ' prompt-health-priority-job' : ''}`}
      onClick={() => onSelect(job)}
    >
      {isPromptHealthPriority && (
        <div className="prompt-health-priority-banner" role="note">
          ★ {PROMPT_HEALTH_PRIORITY_BANNER} ★
        </div>
      )}
      <div className="card-identity">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {job.company && (
              <div className="company-mark" style={{ position: 'relative', padding: 0, overflow: 'hidden' }}>
                <span aria-hidden="true" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', margin: 0 }}>{companyInitials}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
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
          {showStatusBadge && !['interviewing', 'passed'].includes(job.status) && (
            <div className={`job-status-badge ${job.status}`}>
              {job.status.replaceAll('_', ' ')}
            </div>
          )}
          {isHumanPromoted && (
            <div className="human-promoted-badge">Human promoted</div>
          )}
          {travelTier === 'priority' && (
            <div className="travel-priority-badge">Travel priority</div>
          )}
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
          {job.tailoringStaged && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#3b82f6', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(59, 130, 246, 0.1)' }}>
              ✂️ Tailoring
            </div>
          )}
          {job.compensation && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#10b981', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(16, 185, 129, 0.1)' }}>
              💰 {job.compensation}
            </div>
          )}
        </div>
        {scoreReplayNeeded ? (
            <div className="score-authority-card-state stale" role="status">
              <AlertTriangle size={14} /> Prior score hidden · replay in progress
            </div>
          ) : !hasCurrentScoreAuthority ? (
            <div className="score-authority-card-state" role="status">
              {isHumanPromoted ? 'Human-selected opportunity · AI score pending' : 'Pending AI scoring…'}
            </div>
          ) : (
            (() => {
              const bars = primaryScore === 'aim' ? [resumeBar, expBar] : [expBar, resumeBar];
              return [...bars, travelBar];
            })()
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
