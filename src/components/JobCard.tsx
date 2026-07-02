'use client';

import React from 'react';
import { formatDistanceToNow, format, differenceInDays } from 'date-fns';

interface JobCardProps {
  job: any;
  onClick: () => void;
  primaryScore?: 'resume' | 'experience';
}

export default function JobCard({ job, onClick, primaryScore = 'resume' }: JobCardProps) {
  const isStale = job.postedAt && differenceInDays(new Date(), new Date(job.postedAt)) > 30;

  const getFitClass = () => {
    if (job.fitCategory === 'no-tailoring' || job.fitCategory === 'promoted') return 'fit-a';
    if (job.fitCategory === 'minor' || job.fitCategory === 'moderate') return 'fit-b';
    if (job.fitCategory === 'review') return 'fit-c'; // Needs review
    return 'fit-c'; // major, unscored, rejected
  };

  const score = job.fitScore || 0;
  let scoreColor = 'fill-red';
  if (job.fitCategory === 'rejected') scoreColor = 'fill-red';
  else if (job.fitCategory === 'review') scoreColor = 'fill-amber';
  else if (score >= 80 || job.fitCategory === 'promoted') scoreColor = 'fill-green';
  else if (score >= 65) scoreColor = 'fill-amber';

  const resumeBar = (
    <div className="score-row" key="resume" style={{ marginTop: primaryScore === 'resume' ? '0' : '6px' }}>
      <span className="score-label">Resume Fit <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{score}</span></span>
      <div className="score-track">
        <div className={`score-fill ${scoreColor}`} style={{ width: `${score}%` }}></div>
      </div>
    </div>
  );

  const expBar = (
    <div className="score-row" key="exp" style={{ marginTop: primaryScore === 'experience' ? '0' : '6px' }}>
      <span className="score-label">Experience Fit <span style={{ color: 'var(--text)', marginLeft: '4px', fontWeight: 600 }}>{job.reqFitScore || 0}</span></span>
      <div className="score-track">
        <div className={`score-fill ${(job.reqFitScore || 0) >= 80 ? 'fill-green' : (job.reqFitScore || 0) >= 65 ? 'fill-amber' : 'fill-red'}`} style={{ width: `${job.reqFitScore || 0}%` }}></div>
      </div>
    </div>
  );

  let travelColor = 'fill-purple';
  if (job.travelScore !== undefined && job.travelScore !== null) {
    if (job.travelScore >= 75) travelColor = 'fill-green';
    else if (job.travelScore >= 50) travelColor = 'fill-amber';
    else if (job.travelScore >= 25) travelColor = 'fill-red';
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
    <div className={`job-card ${getFitClass()}`} onClick={onClick}>
      <div className="card-identity">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="card-company">{job.company}</div>
          {job.status === 'applied' && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Applied {job.updatedAt ? format(new Date(job.updatedAt), 'MMM d, yyyy') : ''}
            </div>
          )}
        </div>
        <div className="card-title">{job.title}</div>
      </div>
      
      <div className="score-bar">
        {(job.status === 'passed' || job.recommendedResume || job.tailoringStaged) && (
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
            {job.status === 'passed' && (
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'var(--border2)' }}>
                🚫 Passed
              </div>
            )}
            {job.recommendedResume && (
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--accent)', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(255, 62, 165, 0.1)' }}>
                🎯 Resume: {job.recommendedResume}
              </div>
            )}
            {job.tailoringStaged && (
              <div style={{ fontSize: '11px', fontWeight: 600, color: '#3b82f6', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'rgba(59, 130, 246, 0.1)' }}>
                ✂️ Tailoring
              </div>
            )}
          </div>
        )}
        {(job.fitCategory === 'unscored' || job.fitCategory === 'review') && job.fitScore === null && job.reqFitScore === null ? (
          <div style={{ fontSize: '12px', color: 'var(--muted)', fontStyle: 'italic', padding: '4px 0' }}>
            {job.fitCategory === 'review' ? 'Awaiting JD / Manual Review...' : 'Pending AI Scoring...'}
          </div>
        ) : (
          primaryScore === 'experience' ? [expBar, resumeBar, travelBar] : [resumeBar, expBar, travelBar]
        )}
      </div>

      <div className="card-footer">
        <span className="card-location">{job.location || 'Remote'}</span>
        <span className="card-age" style={{ textAlign: 'right' }}>
          <div style={isStale ? { fontWeight: 'bold', color: '#800000' } : {}}>
            {job.source && `${job.source} • `}Posted {job.postedAt ? formatDistanceToNow(new Date(job.postedAt)) : '1d'} ago
          </div>
          <div style={{ opacity: 0.7 }}>In Dash: {job.createdAt ? formatDistanceToNow(new Date(job.createdAt)) : 'just now'}</div>
        </span>
      </div>
    </div>
  );
}
