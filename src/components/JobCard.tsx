'use client';

import React from 'react';
import { formatDistanceToNow, format, differenceInDays } from 'date-fns';
import { identifyAts, ATS_OPTIONS } from '@/lib/atsUtils';

const RESUME_OPTIONS = ['Core', 'AI', 'Clinical'];

interface JobCardProps {
  job: any;
  onClick: () => void;
  primaryScore?: 'aim' | 'experience' | 'resume';
  onJobUpdate?: (id: string, updates: any) => void;
  showAtsBadge?: boolean;
}

export default function JobCard({ job, onClick, primaryScore = 'aim', onJobUpdate, showAtsBadge }: JobCardProps) {
  const updateJob = async (updates: any) => {
    try {
      if (onJobUpdate) onJobUpdate(job.id, updates);
      await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
    } catch(e) {
      console.error('Failed to update job', e);
    }
  };

  const isStale = job.postedAt && differenceInDays(new Date(), new Date(job.postedAt)) > 30;

  const getFitClass = () => {
    const expScore = job.reqFitScore || 0;
    if (job.fitCategory === 'promoted') return 'fit-a'; // Keep promoted logic if applicable, though maybe just use score
    if (expScore >= 80) return 'fit-a';
    if (expScore >= 65) return 'fit-b';
    return 'fit-c';
  };

  const score = job.aimFitScore ?? job.fitScore ?? 0;
  let scoreColor = 'fill-red';
  if (job.fitCategory === 'rejected') scoreColor = 'fill-red';
  else if (job.fitCategory === 'review') scoreColor = 'fill-amber';
  else if (score >= 80 || job.fitCategory === 'promoted') scoreColor = 'fill-green';
  else if (score >= 65) scoreColor = 'fill-amber';

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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {job.company && (
              <img 
                src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${job.company.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}.com&size=64`} 
                alt="" 
                style={{ width: '16px', height: '16px', borderRadius: '4px', objectFit: 'contain' }}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
            <div className="card-company">{job.company}</div>
          </div>
          {job.status === 'applied' && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Applied {job.updatedAt ? format(new Date(job.updatedAt), 'MMM d, yyyy') : ''}
            </div>
          )}
        </div>
        <div className="card-title">{job.title}</div>
      </div>
      
      <div className="score-bar">
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
          {job.status === 'passed' && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', display: 'inline-block', padding: '2px 8px', borderRadius: '12px', background: 'var(--border2)' }}>
              🚫 Passed
            </div>
          )}
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <select
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--accent)',
                display: 'inline-block',
                padding: '2px 20px 2px 8px',
                borderRadius: '12px',
                background: 'rgba(255, 62, 165, 0.1)',
                border: 'none',
                appearance: 'none',
                cursor: 'pointer',
                outline: 'none'
              }}
              value={job.recommendedResume || 'Core'}
              onChange={(e) => updateJob({ recommendedResume: e.target.value })}
              onClick={(e) => e.stopPropagation()}
            >
              {RESUME_OPTIONS.map(r => <option key={r} value={r}>🎯 Resume: {r}</option>)}
            </select>
            <div style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '8px', color: 'var(--accent)' }}>▼</div>
          </div>
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
        {job.aimFitScore === null && job.reqFitScore === null && job.fitScore === null ? (
          <div style={{ fontSize: '12px', color: 'var(--muted)', fontStyle: 'italic', padding: '4px 0' }}>
            Pending AI Scoring...
          </div>
        ) : (
          (() => {
            const bars = primaryScore === 'aim' ? [resumeBar, expBar] : [expBar, resumeBar];
            return [...bars, travelBar];
          })()
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
