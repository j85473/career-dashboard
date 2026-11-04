'use client';

import React from 'react';
import { formatDistanceToNow, format, differenceInDays } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { identifyAts, ATS_OPTIONS } from '@/lib/atsUtils';
import { showAlert } from '@/lib/modal';
import type { JobListItem } from '@/types/job';
import { isAcostaChannelSalesPriorityRole, ACOSTA_CHANNEL_SALES_PRIORITY_BANNER, isPromptHealthPriorityRole, PROMPT_HEALTH_PRIORITY_BANNER } from '@/lib/priorityOpportunity';
import { travelOpportunityTier } from '@/lib/travelOpportunity';
import { TravelRangeTrack } from '@/components/TravelRangeTrack';
import { aimScoreFillClass } from '@/lib/aimDisplay';
import { isAppliedDuplicateReason } from '@/lib/appliedDuplicatePolicy';
import { consolidatedIntoJobId } from '@/lib/jobConsolidationReason';
import { companyDisplayName } from '@/lib/companyPresentation';
import { CompanyLogo } from '@/components/CompanyLogo';
import { InterviewSchedule } from '@/components/InterviewSchedule';
import { JobDocuments } from '@/components/JobDocuments';
import { interviewSortKey } from '@/lib/jobInterviewSchedule';



interface JobCardProps {
  job: JobListItem;
  onSelect: (job: JobListItem) => void;
  primaryScore?: 'aim' | 'experience';
  onJobUpdate?: (jobId: string, updates: Partial<JobListItem>) => void;
  showAtsBadge?: boolean;
  showStatusBadge?: boolean;
}
function JobCard({ job, onSelect, primaryScore = 'aim', onJobUpdate, showStatusBadge = false }: JobCardProps) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    if (job.status !== 'interviewing' || !job.interviews?.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [job.status, job.interviews]);
  const isPromptHealthPriority = isPromptHealthPriorityRole(job);
  const isAcostaPriority = isAcostaChannelSalesPriorityRole(job);
  const hasCurrentScoreAuthority = job.scoreAuthorityState === 'current';
  const scoreReplayNeeded = job.scoreAuthorityState === 'stale_replay_needed';
  const isHumanPromoted = /^Promoted by user:/i.test(job.passReason || '');
  // Dismissed because it repeats a job already decided on. Badged rather than
  // hidden silently, so a wrong fingerprint match is visible when browsing
  // dismissed instead of quietly costing an opportunity.
  const isAppliedDuplicate = isAppliedDuplicateReason(job.passReason) || job.combinedInto?.alreadyApplied;
  const isCombinedCopy = consolidatedIntoJobId(job.passReason) !== null;
  const companyLabel = job.employer || companyDisplayName(job.company, job.source);
  const [interviewTiming, interviewAt] = interviewSortKey(job, now);
  const nextInterviewAt = job.status === 'interviewing' && interviewTiming === 0
    ? new Date(interviewAt) : null;

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

    if (primaryScore === 'experience' && authoritativeExperience != null) {
      if (authoritativeExperience >= 80) return 'fit-a';
      if (authoritativeExperience >= 65) return 'fit-b';
      return 'fit-c';
    }
    if (aimScore != null) {
      const v2Band = job.aimDisplayBand;
      if (v2Band) return v2Band.cardClass;
      return aimScore >= 80 ? 'fit-a' : aimScore >= 65 ? 'fit-b' : 'fit-c';
    }
    if (authoritativeExperience != null) return authoritativeExperience >= 80 ? 'fit-a' : authoritativeExperience >= 65 ? 'fit-b' : 'fit-c';
    return 'fit-pending';
  };

  const rawScore = hasCurrentScoreAuthority ? job.aimFitScore : null;
  const hasAimScore = rawScore != null;
  const score = rawScore ?? 0;
  const experienceFitScore: number | null = hasCurrentScoreAuthority ? job.reqFitScore ?? null : null;
  const hasExperienceScore = experienceFitScore != null;
  const experienceScore = experienceFitScore ?? 0;
  
  const scoreColor = !hasAimScore
    ? 'fill-muted'
    : aimScoreFillClass(score, job.aimSchemaVersion);

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
  const travelTier = travelOpportunityTier(authoritativeTravelScore);
  const travelRange = hasCurrentScoreAuthority ? job.travelRange : null;

  const travelBar = travelRange ? (
    <div className="score-row" key="travel" style={{ marginTop: '6px' }}>
      <span className="score-label">Travel <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{travelRange.label}</span></span>
      <TravelRangeTrack range={travelRange} />
    </div>
  ) : null;

  return (
    <article
      className={`job-card ${getFitClass()}${isPromptHealthPriority ? ' prompt-health-priority-job' : ''}${isAcostaPriority ? ' acosta-channel-sales-priority-job' : ''}`}
      onClick={() => onSelect(job)}
    >
      {isAcostaPriority && (
        <div className="priority-opportunity-banner" role="note">
          ★ {ACOSTA_CHANNEL_SALES_PRIORITY_BANNER} ★
        </div>
      )}
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
                <CompanyLogo company={companyLabel} url={job.url} canonicalUrl={job.canonicalUrl} jobId={job.id} />
              </div>
            )}
            <div className="card-company" title={companyLabel !== job.company ? `Listed employer: ${job.company}` : undefined}>{companyLabel}</div>
          </div>
          {(job.status === 'applied' || job.status === 'interviewing') && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {nextInterviewAt
                ? <>Interview {format(nextInterviewAt, 'MMM d, yyyy')}</>
                : <>Applied {job.appliedAt ? format(new Date(job.appliedAt), 'MMM d, yyyy') : ''}</>}
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
          aria-label={`Open ${job.title} at ${companyLabel}`}
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
          {(job.verificationStatus === 'unavailable' || job.verificationStatus === 'expired') && (
            <div className="job-status-badge cooldown" title="Availability check only; saved scores and your decision are preserved.">
              {job.verificationStatus === 'expired' ? 'Posting closed' : 'Application page unavailable'}
            </div>
          )}
          {isAppliedDuplicate && (
            <div className="applied-duplicate-badge" title={job.passReason || undefined}>
              Already applied{job.combinedInto?.appliedAt ? ` · ${format(new Date(job.combinedInto.appliedAt), 'MMM d, yyyy')}` : ''}
            </div>
          )}
          {isCombinedCopy && !isAppliedDuplicate && (
            <div className="job-status-badge">Combined with another card</div>
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
                value={identifyAts(job)}
                onChange={(e) => updateJob({ manualAts: e.target.value })}
                onClick={(e) => e.stopPropagation()}
              >
                <option value={identifyAts(job)} disabled>⚙️ ATS: {identifyAts(job)}</option>
                {ATS_OPTIONS.map(r => <option key={r} value={r}>⚙️ ATS: {r}</option>)}
              </select>
              <div style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '8px', color: '#eab308' }}>▼</div>
            </div>
          {job.postedCompensation && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#10b981', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(16, 185, 129, 0.1)' }}>
              💰 {job.postedCompensation}
            </div>
          )}
          {job.postedTravel && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#38bdf8', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(56, 189, 248, 0.1)' }}>
              ✈️ {job.postedTravel} travel
            </div>
          )}
          {job.tailoringStaged && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#3b82f6', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(59, 130, 246, 0.1)' }}>
              ✂️ Tailoring
            </div>
          )}
        </div>
        {scoreReplayNeeded ? (
            <div className="score-authority-card-state stale" role="status">
              <AlertTriangle size={14} /> Prior score hidden · replay in progress
            </div>
          ) : !hasCurrentScoreAuthority ? (
            <div className="score-authority-card-state" role="status">
              {isAcostaPriority && job.scoringStatus === 'skipped'
                ? 'Priority opportunity · Ready to review'
                : isHumanPromoted ? 'Human-selected opportunity · AI score pending' : 'Pending AI scoring…'}
            </div>
          ) : (
            (() => {
              const bars = primaryScore === 'aim' ? [resumeBar, expBar] : [expBar, resumeBar];
              return [...bars, travelBar];
            })()
          )}
      </div>

      {(job.status === 'interviewing' || Boolean(job.interviews?.length)) && (
        <InterviewSchedule job={job} onJobUpdate={onJobUpdate} />
      )}

      <JobDocuments job={job} onJobUpdate={onJobUpdate} />

      <div className="card-footer">
        <span className="card-location">{job.location || 'Location not provided'}</span>
        <span className="card-age">
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
