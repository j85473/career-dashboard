import React, { useState } from 'react';
import { Bookmark, CheckCircle, XCircle, ExternalLink, AlertTriangle, Edit2, Loader2, Save } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { identifyAts, ATS_OPTIONS } from '@/lib/atsUtils';

interface ExpandOverlayProps {
  job: any;
  onClose: () => void;
  onStatusChange: (id: string, status: string, reason?: string) => void;
  onToggleTailoring?: (id: string, isStaged: boolean) => void;
  onJobUpdate?: (id: string, updates: any) => void;
  primaryScore?: 'resume' | 'experience';
}

const RESUME_OPTIONS = ['Core', 'AI', 'Clinical'];

export function ExpandOverlay({ job: initialJob, onClose, onStatusChange, onToggleTailoring, onJobUpdate, primaryScore = 'resume' }: ExpandOverlayProps) {
  const [job, setJob] = useState(initialJob);
  const [passReason, setPassReason] = useState('');
  const [showPassInput, setShowPassInput] = useState(false);
  const [promoteReason, setPromoteReason] = useState('');
  const [showPromoteInput, setShowPromoteInput] = useState(false);

  // New States for overrides
  const [isEditingJD, setIsEditingJD] = useState(false);
  const [manualJD, setManualJD] = useState(job.description || '');
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [manualTitle, setManualTitle] = useState(job.title || '');
  const [manualCompany, setManualCompany] = useState(job.company || '');
  const [manualLocation, setManualLocation] = useState(job.location || '');
  const [directUrl, setDirectUrl] = useState('');
  const [isScraping, setIsScraping] = useState(false);

  React.useEffect(() => {
    setJob(initialJob);
  }, [initialJob]);

  if (!job) return null;

  const score = job.fitScore || 0;
  let scoreColor = 'fill-red';
  let bucket = 'c';
  if (score >= 80 || job.fitCategory === 'promoted') {
    scoreColor = 'fill-green';
    bucket = 'a';
  } else if (score >= 65) {
    scoreColor = 'fill-amber';
    bucket = 'b';
  }

  const handleUpdateJD = async () => {
    try {
      let skipRescore = false;
      if (job.status === 'inbox') {
        const wantsRescore = window.confirm('Do you want to send this job back to the queue for re-scoring?');
        if (!wantsRescore) {
          skipRescore = true;
        }
      }

      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          description: manualJD,
          skipRescore,
          scoringStatus: 'needs_jd', 
          experienceStatus: 'queued',
          reqFitScore: null,
          reqFitRationale: null
        })
      });
      if (res.ok) {
        setIsEditingJD(false);
        const data = await res.json();
        setJob(data.job);
        alert("Description updated successfully. The job will be rescored.");
      }
    } catch(e) {
      console.error('Failed to update JD', e);
      alert('Failed to update job description. Please try again.');
    }
  };

  const handleUpdateMeta = async () => {
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          title: manualTitle,
          company: manualCompany,
          location: manualLocation
        })
      });
      if (res.ok) {
        setIsEditingMeta(false);
        const data = await res.json();
        setJob(data.job);
        if (onJobUpdate) onJobUpdate(job.id, { title: manualTitle, company: manualCompany, location: manualLocation });
      }
    } catch(e) {
      console.error('Failed to update meta', e);
      alert('Failed to update job details. Please try again.');
    }
  };

  const updateJob = async (updates: any) => {
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        setJob({ ...job, ...updates });
        if (onJobUpdate) onJobUpdate(job.id, updates);
      }
    } catch(e) {
      console.error('Failed to update job', e);
      alert('Failed to update job status. Please try again.');
    }
  };

  const handlePass = () => {
    if (!showPassInput) {
      setShowPassInput(true);
    } else {
      if (passReason.trim()) {
        onStatusChange(job.id, 'passed', passReason);
        onClose();
      }
    }
  };

  const handlePromote = () => {
    if (!showPromoteInput) {
      setShowPromoteInput(true);
    } else {
      if (promoteReason.trim()) {
        onStatusChange(job.id, 'promoted', promoteReason);
        onClose();
      }
    }
  };

  const handleScrape = async () => {
    if (!directUrl.trim()) return;
    
    let skipRescore = false;
    if (job.status === 'inbox') {
      const wantsRescore = window.confirm('Do you want to send this job back to the queue for re-scoring after scraping?');
      if (!wantsRescore) {
        skipRescore = true;
      }
    }

    setIsScraping(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: directUrl, skipRescore })
      });
      const data = await res.json();
      if (res.ok) {
        setJob(data.job);
        setManualJD(data.job.description);
        setDirectUrl('');
        alert("Scrape successful! The job description has been updated and a rescore has been queued.");
      } else {
        if (data.job) setJob(data.job);
        alert("Scraping failed. You can now manually edit the description.");
        setIsEditingJD(true);
      }
    } catch(e) {
      alert("Scraping failed. You can now manually edit the description.");
      setIsEditingJD(true);
    }
    setIsScraping(false);
  };

  const resumeBarRow = (
    <div className="expand-score-row" key="resume" style={{ marginTop: primaryScore === 'resume' ? '0' : '12px' }}>
      <div className="expand-score-top"><span className="expand-score-label">Aim Fit</span><span className="expand-score-num">{score}</span></div>
      <div className="expand-score-track"><div className={`expand-score-fill ${scoreColor}`} style={{width: `${score}%`}}></div></div>
    </div>
  );

  const expBarRow = job.reqFitScore !== undefined && job.reqFitScore !== null ? (
    <div className="expand-score-row" key="exp" style={{ marginTop: primaryScore === 'experience' ? '0' : '12px' }}>
      <div className="expand-score-top"><span className="expand-score-label">Experience Fit</span><span className="expand-score-num">{job.reqFitScore}</span></div>
      <div className="expand-score-track">
        <div className={`expand-score-fill ${job.reqFitScore >= 80 ? 'fill-green' : job.reqFitScore >= 65 ? 'fill-amber' : 'fill-red'}`} style={{width: `${job.reqFitScore}%`}}></div>
      </div>
    </div>
  ) : null;

  let travelColor = 'fill-purple';
  if (job.travelScore !== undefined && job.travelScore !== null) {
    if (job.travelScore >= 75) travelColor = 'fill-green';
    else if (job.travelScore >= 50) travelColor = 'fill-amber';
    else if (job.travelScore >= 25) travelColor = 'fill-red';
  }

  const travelBarRow = job.travelScore !== undefined && job.travelScore !== null ? (
    <div className="expand-score-row" key="travel" style={{ marginTop: '12px' }}>
      <div className="expand-score-top"><span className="expand-score-label">Travel Required</span><span className="expand-score-num">{job.travelScore}</span></div>
      <div className="expand-score-track">
        <div className={`expand-score-fill ${travelColor}`} style={{width: `${job.travelScore}%`}}></div>
      </div>
    </div>
  ) : null;

  const resumeRationaleSection = job.fitRationale ? (
    <div key="resumeRationale" style={{ marginTop: '20px' }}>
      <div className="expand-section-title">Resume Rationale</div>
      <div className="expand-desc">{job.fitRationale}</div>
    </div>
  ) : null;

  const expRationaleSection = job.reqFitRationale ? (
    <div key="expRationale" style={{ marginTop: '20px' }}>
      <div className="expand-section-title">Experience Rationale</div>
      <div className="expand-desc">{job.reqFitRationale}</div>
    </div>
  ) : null;

  return (
    <div className="expand-overlay open">
      <div className="expand-header">
        <div className="expand-header-left">
          <div className="expand-logo">
            <img 
              src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${job.company.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}.com&size=64`} 
              alt={job.company} 
              style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: '8px' }}
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                e.currentTarget.parentElement!.innerHTML = job.company.substring(0, 2).toUpperCase();
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            {!isEditingMeta ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div className="expand-title">{job.title}</div>
                  <button onClick={() => setIsEditingMeta(true)} className="expand-btn" style={{ padding: '2px 6px', fontSize: '11px', background: 'transparent', border: 'none', color: 'var(--muted)' }}>
                    <Edit2 size={12} />
                  </button>
                </div>
                <div className="expand-company">{job.company} · {job.location || 'Remote'}</div>
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px', maxWidth: '400px' }}>
                <input 
                  type="text" 
                  value={manualTitle} 
                  onChange={(e) => setManualTitle(e.target.value)} 
                  className="feedback-input" 
                  style={{ fontSize: '20px', fontWeight: 600, padding: '4px 8px' }}
                  placeholder="Job Title"
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input 
                    type="text" 
                    value={manualCompany} 
                    onChange={(e) => setManualCompany(e.target.value)} 
                    className="feedback-input" 
                    style={{ flex: 1, padding: '4px 8px' }}
                    placeholder="Company"
                  />
                  <input 
                    type="text" 
                    value={manualLocation} 
                    onChange={(e) => setManualLocation(e.target.value)} 
                    className="feedback-input" 
                    style={{ flex: 1, padding: '4px 8px' }}
                    placeholder="Location"
                  />
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button onClick={handleUpdateMeta} className="expand-btn primary" style={{ padding: '4px 12px', fontSize: '12px' }}>Save</button>
                  <button onClick={() => setIsEditingMeta(false)} className="expand-btn" style={{ padding: '4px 12px', fontSize: '12px' }}>Cancel</button>
                </div>
              </div>
            )}
            
            <div className="expand-company" style={{ fontSize: '11px', marginTop: '3px' }}>
              Posted {job.postedAt ? formatDistanceToNow(new Date(job.postedAt)) : '1d'} ago · In Dash {job.createdAt ? formatDistanceToNow(new Date(job.createdAt)) : 'just now'}
            </div>
            <div className="expand-badges">
              <span className={`expand-badge ${bucket}`}>{bucket.toUpperCase()} · {score}</span>
              
              {job.status === 'passed' && (
                <span className="expand-badge meta" style={{ background: 'var(--border2)', color: 'var(--text-muted)' }}>🚫 Passed</span>
              )}
              
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <select 
                  className="expand-badge" 
                  style={{ background: 'rgba(255, 62, 165, 0.15)', color: 'var(--accent)', border: 'none', appearance: 'none', cursor: 'pointer', paddingRight: '20px' }}
                  value={job.recommendedResume || 'Core'}
                  onChange={(e) => updateJob({ recommendedResume: e.target.value })}
                >
                  {RESUME_OPTIONS.map(r => <option key={r} value={r}>🎯 Use {r.replace('Generic_User_Control_Resume_3.0_', '').replace('.docx', '')}</option>)}
                </select>
                <div style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '9px', color: 'var(--accent)' }}>▼</div>
              </div>

              <span className="expand-badge meta">{job.location || 'Remote'}</span>
              {job.fitCategory && job.fitCategory !== 'unscored' && (
                <span className="expand-badge meta" style={{textTransform: 'capitalize'}}>{job.fitCategory} Tailoring</span>
              )}
              {job.source && job.source.toLowerCase() !== 'careerforce' && (
                <span className="expand-badge meta">Via {job.source}</span>
              )}
              
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <select
                  className="expand-badge meta"
                  style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: 'none', appearance: 'none', cursor: 'pointer', paddingRight: '20px' }}
                  value={job.manualAts || identifyAts(job)}
                  onChange={(e) => updateJob({ manualAts: e.target.value })}
                >
                  <option value={identifyAts(job)} disabled>⚙️ ATS: {identifyAts(job)}</option>
                  {ATS_OPTIONS.map(ats => <option key={ats} value={ats}>{ats}</option>)}
                </select>
                <div style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '9px', color: '#10b981' }}>▼</div>
              </div>

              {job.source && job.source.toLowerCase() === 'careerforce' && (
                <span className="expand-badge meta" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', fontWeight: 600 }}>
                  🦅 CareerForce
                </span>
              )}

            </div>
          </div>
        </div>
        <button className="expand-close" onClick={onClose}>✕</button>
      </div>

      <div className="expand-body">
        <div className="expand-col">
          <div className="expand-section-title">{primaryScore === 'experience' ? 'Experience Fit' : 'Aim Fit'}</div>
          <div className="expand-scores">
            {primaryScore === 'experience' ? [expBarRow, resumeBarRow, travelBarRow] : [resumeBarRow, expBarRow, travelBarRow]}
          </div>
          {primaryScore === 'experience' ? [expRationaleSection, resumeRationaleSection] : [resumeRationaleSection, expRationaleSection]}
        </div>

        <div className="expand-col" style={{ flex: 1.5 }}>
          <div className="expand-section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              About the Role
              {job.description && job.description.length < 400 && !isEditingJD && (
                <span style={{ fontSize: '12px', color: '#f5a623', background: 'rgba(245, 166, 35, 0.1)', padding: '2px 8px', borderRadius: '4px', fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <AlertTriangle size={14} /> Truncated
                </span>
              )}
            </div>
            {!isEditingJD ? (
              <button onClick={() => setIsEditingJD(true)} className="expand-btn" style={{ padding: '2px 8px', fontSize: '12px' }}>
                <Edit2 size={12} style={{ marginRight: '4px' }}/> Edit JD
              </button>
            ) : (
              <button onClick={handleUpdateJD} className="expand-btn" style={{ padding: '2px 8px', fontSize: '12px', background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}>
                <Save size={12} style={{ marginRight: '4px' }}/> Save JD
              </button>
            )}
          </div>
          
          {isEditingJD ? (
            <textarea 
              value={manualJD}
              onChange={(e) => setManualJD(e.target.value)}
              style={{ width: '100%', height: '300px', background: 'var(--bg-card)', color: 'var(--text-main)', border: '1px solid var(--border)', padding: '10px', borderRadius: '8px', fontFamily: 'inherit', fontSize: '14px', resize: 'vertical' }}
              placeholder="Paste full job description here..."
            />
          ) : (
            <div className="expand-desc" style={{ whiteSpace: 'pre-wrap' }}>{job.description}</div>
          )}
        </div>
      </div>

      <div className="expand-footer">
        {job.status === 'dismissed' ? (
          <>
            {showPromoteInput && (
              <input 
                type="text" 
                className="feedback-input expand-footer-input" 
                placeholder="Why promote? AI will learn this." 
                value={promoteReason}
                onChange={(e) => setPromoteReason(e.target.value)}
              />
            )}
            <div className="expand-footer-right">
              <div className="expand-footer-scrape">
                <input type="text" className="feedback-input expand-footer-input" placeholder="Paste Direct URL..." value={directUrl} onChange={(e) => setDirectUrl(e.target.value)} />
                <button className="expand-btn" onClick={handleScrape} disabled={isScraping}>
                  {isScraping ? <Loader2 size={16} className="animate-spin" /> : 'Scrape'}
                </button>
              </div>
              <button className="expand-btn" onClick={() => window.open(`/api/jobs/${job.id}/redirect`, '_blank', 'noreferrer')} style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                <ExternalLink size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                View Posting
              </button>
              <button className="expand-btn" onClick={handlePromote}>
                <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                {showPromoteInput ? 'Confirm Promote' : 'Promote to Inbox'}
              </button>
            </div>
          </>
        ) : (
          <>
            {job.status === 'passed' ? (
              <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'inbox'); onClose(); }}>
                Restore to Inbox
              </button>
            ) : (
              <>
                {showPassInput && (
                  <input 
                    type="text" 
                    className="feedback-input expand-footer-input" 
                    placeholder="Why are you passing?" 
                    value={passReason}
                    onChange={(e) => setPassReason(e.target.value)}
                  />
                )}
                <button className="expand-btn" onClick={handlePass} style={{ color: 'var(--red)' }}>
                  <XCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                  {showPassInput ? 'Confirm Pass' : 'Pass'}
                </button>
                <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'expired'); onClose(); }} style={{ color: '#800000' }}>
                  <AlertTriangle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                  Mark Expired
                </button>
              </>
            )}
            
            <div className="expand-footer-right">
              <div className="expand-footer-scrape">
                <input type="text" className="feedback-input expand-footer-input" placeholder="Paste Direct URL..." value={directUrl} onChange={(e) => setDirectUrl(e.target.value)} />
                <button className="expand-btn" onClick={handleScrape} disabled={isScraping}>
                  {isScraping ? <Loader2 size={16} className="animate-spin" /> : 'Scrape'}
                </button>
              </div>
              <button className="expand-btn" onClick={() => window.open(`/api/jobs/${job.id}/redirect`, '_blank', 'noreferrer')} style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                <ExternalLink size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                View Posting
              </button>
              {job.status === 'bookmarked' ? (
                <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'inbox'); onClose(); }}>
                  <Bookmark size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                  Unbookmark
                </button>
              ) : (
                <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'bookmarked'); onClose(); }}>
                  <Bookmark size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                  Bookmark
                </button>
              )}
              {job.status === 'applied' || job.status === 'interviewing' ? (
                <>
                  <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'inbox'); onClose(); }} style={{ borderColor: '#ef4444', color: '#ef4444' }}>
                    <XCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Not Applied
                  </button>
                  {job.status === 'applied' && (
                    <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'interviewing'); onClose(); }} style={{ borderColor: '#3b82f6', color: '#3b82f6' }}>
                      <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                      Interviewing
                    </button>
                  )}
                  {job.status === 'interviewing' && (
                    <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'applied'); onClose(); }} style={{ borderColor: '#f59e0b', color: '#f59e0b' }}>
                      <XCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                      Back to Applied
                    </button>
                  )}
                </>
              ) : (
                <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'applied'); onClose(); }} style={{ borderColor: '#22c55e', color: '#22c55e' }}>
                  <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                  I've Applied
                </button>
              )}
              {onToggleTailoring && (
                job.tailoringStaged ? (
                  <button className="expand-btn primary" onClick={() => { onToggleTailoring(job.id, false); onClose(); }}>
                    <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Unstage Resume
                  </button>
                ) : (
                  <button className="expand-btn primary" onClick={() => { onToggleTailoring(job.id, true); onClose(); }}>
                    <Bookmark size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Stage for Tailoring
                  </button>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
