import React, { useState } from 'react';
import { ExternalLink, Loader, Copy, Check, ThumbsDown, MessageSquare, RefreshCw } from 'lucide-react';
import { useModalDialog } from '@/hooks/useModalDialog';
import { showAlert } from '@/lib/modal';

interface OutreachTarget {
  id: string;
  firstName: string;
  lastName: string;
  company?: string | null;
  locationText?: string | null;
  email?: string | null;
  headline?: string | null;
  about?: string | null;
  generatedNote?: string | null;
  generatedPitch?: string | null;
  linkedinUrl: string;
  status: string;
}

export function OutreachExpandOverlay({ target, onClose, onTargetUpdate }: { target: OutreachTarget, onClose: () => void, onTargetUpdate: (id: string, updates: Partial<OutreachTarget>) => void }) {
  const dialogRef = useModalDialog(onClose);
  const [generatingNote, setGeneratingNote] = useState(false);
  const [generatingEmail, setGeneratingEmail] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [copiedNote, setCopiedNote] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);

  const handleGenerateNote = async () => {
    setGeneratingNote(true);
    try {
      const res = await fetch(`/api/outreach/${target.id}/generate?type=note`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to generate the note.');
      onTargetUpdate(target.id, { generatedNote: data.generatedNote });
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Failed to generate the note.');
    } finally {
      setGeneratingNote(false);
    }
  };

  const handleGenerateEmail = async () => {
    setGeneratingEmail(true);
    try {
      const res = await fetch(`/api/outreach/${target.id}/generate?type=email`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to generate the email.');
      onTargetUpdate(target.id, { generatedPitch: data.generatedPitch });
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Failed to generate the email.');
    } finally {
      setGeneratingEmail(false);
    }
  };

  const handleStatusUpdate = async (newStatus: string) => {
    setUpdating(true);
    try {
      const res = await fetch(`/api/outreach/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update outreach status.');
      onTargetUpdate(target.id, data.target || { status: newStatus });
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'Failed to update outreach status.');
    } finally {
      setUpdating(false);
    }
  };

  const handleCopyNote = () => {
    if (!target.generatedNote) return;
    navigator.clipboard.writeText(target.generatedNote);
    setCopiedNote(true);
    setTimeout(() => setCopiedNote(false), 2000);
  };

  const handleCopyEmail = () => {
    if (!target.generatedPitch) return;
    navigator.clipboard.writeText(target.generatedPitch);
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2000);
  };

  return (
    <div className="expand-overlay open" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="expand-modal" role="dialog" aria-modal="true" aria-labelledby="outreach-dialog-title" tabIndex={-1} ref={dialogRef}>
      <div className="expand-header">
        <div className="expand-header-left">
          <div className="expand-logo" style={{ position: 'relative', overflow: 'hidden' }}>
            <span style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
              {(target.company || '?').trim().slice(0, 2).toUpperCase()}
            </span>
            {target.company && (
              <img 
                src={`https://www.google.com/s2/favicons?domain=${target.company.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}.com&sz=128`} 
                alt=""
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain', background: 'white' }}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="expand-title" id="outreach-dialog-title">{target.firstName} {target.lastName}</div>
            </div>
            <div className="expand-company">{target.company || 'Unknown Company'} · {target.locationText || 'Location Unknown'}</div>
            {target.email && (
              <div className="expand-company" style={{ fontSize: '13px', marginTop: '2px', color: 'var(--green)', fontWeight: 500 }}>
                📧 {target.email}
              </div>
            )}
            <div className="expand-company" style={{ fontSize: '12px', marginTop: '4px', maxWidth: '90%' }}>{target.headline}</div>
          </div>
        </div>
        <button className="expand-close" onClick={onClose} aria-label="Close outreach details">✕</button>
      </div>

      <div className="expand-body" style={{ overflowY: 'auto' }}>
        <div className="expand-col" style={{ flex: 1 }}>
          {/* About Section */}
          {target.about && (
            <div style={{ marginBottom: '24px' }}>
              <div className="expand-section-title">About</div>
              <div className="expand-desc" style={{ whiteSpace: 'pre-wrap' }}>
                {target.about}
              </div>
            </div>
          )}

          <div className="outreach-message-grid">
            {/* LinkedIn Note Section */}
            <div style={{ flex: 1, marginBottom: '32px' }}>
              <div className="expand-section-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <MessageSquare size={16} color="#0a66c2" /> 
                LinkedIn Connection Note (Max 300 Chars)
              </div>
              
              {!target.generatedNote ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '30px 20px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border2)' }}>
                  <p style={{ color: 'var(--muted)', marginBottom: '16px', fontSize: '13px', textAlign: 'center' }}>
                    Generate a hyper-brief cold open note to attach to your connection request.
                  </p>
                  <button className="btn btn-primary" onClick={handleGenerateNote} disabled={generatingNote} style={{ padding: '8px 16px', fontSize: '13px' }}>
                    {generatingNote ? <Loader className="spin" size={14} /> : 'Generate Note'}
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ position: 'relative' }}>
                    <div className="expand-desc" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-card)', padding: '24px', borderRadius: '8px', border: '1px solid #0a66c2', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                      {target.generatedNote}
                    </div>
                    <div style={{ position: 'absolute', top: '12px', right: '12px', display: 'flex', gap: '8px' }}>
                      <button 
                        className="expand-btn" 
                        onClick={handleGenerateNote}
                        disabled={generatingNote}
                        style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {generatingNote ? <Loader className="spin" size={12} /> : <RefreshCw size={12} />}
                        {generatingNote ? 'Regenerating...' : 'Regenerate'}
                      </button>
                      <button 
                        className="expand-btn primary" 
                        onClick={handleCopyNote}
                        style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', background: '#0a66c2', borderColor: '#0a66c2', color: '#fff' }}
                      >
                        {copiedNote ? <Check size={12} /> : <Copy size={12} />}
                        {copiedNote ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Email Pitch Section */}
            <div style={{ flex: 1, marginBottom: '32px' }}>
              <div className="expand-section-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <MessageSquare size={16} color="var(--accent)" />
                Email Cold Pitch
              </div>
              
              {!target.generatedPitch ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '30px 20px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border2)' }}>
                  <p style={{ color: 'var(--muted)', marginBottom: '16px', fontSize: '13px', textAlign: 'center' }}>
                    Generate a customized email pitch based on the &quot;Enablement &amp; Friction&quot; template.
                  </p>
                  <button className="btn btn-primary" onClick={handleGenerateEmail} disabled={generatingEmail} style={{ padding: '8px 16px', fontSize: '13px' }}>
                    {generatingEmail ? <Loader className="spin" size={14} /> : 'Generate Email'}
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ position: 'relative' }}>
                    <div className="expand-desc" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-card)', padding: '24px', borderRadius: '8px', border: '1px solid var(--accent)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                      {target.generatedPitch}
                    </div>
                    <div style={{ position: 'absolute', top: '12px', right: '12px', display: 'flex', gap: '8px' }}>
                      <button 
                        className="expand-btn" 
                        onClick={handleGenerateEmail}
                        disabled={generatingEmail}
                        style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {generatingEmail ? <Loader className="spin" size={12} /> : <RefreshCw size={12} />}
                        {generatingEmail ? 'Regenerating...' : 'Regenerate'}
                      </button>
                      <button 
                        className="expand-btn primary" 
                        onClick={handleCopyEmail}
                        style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {copiedEmail ? <Check size={12} /> : <Copy size={12} />}
                        {copiedEmail ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="expand-footer">
        <div style={{ display: 'flex', gap: '8px' }}>
          <button 
            className={`expand-btn ${target.status === 'inbox' ? 'primary' : ''}`}
            onClick={() => handleStatusUpdate('inbox')}
            disabled={updating}
          >
            Inbox
          </button>
          <button 
            className={`expand-btn ${target.status === 'passed' ? 'primary' : ''}`}
            onClick={() => handleStatusUpdate('passed')}
            disabled={updating}
            style={target.status === 'passed' ? { background: '#800000', borderColor: '#800000', color: '#fff' } : { color: '#800000', borderColor: '#800000' }}
          >
            <ThumbsDown size={14} style={{ marginRight: '6px' }} />
            Pass
          </button>
        </div>
        
        <div className="expand-footer-right">
          {target.email && (
            <button 
              className="expand-btn"
              onClick={() => {
                let subject = 'Intro from Joseph Lamb';
                let body = '';
                
                if (target.generatedPitch) {
                  const subjectMatch = target.generatedPitch.match(/Subject:\s*(.+)/);
                  if (subjectMatch) subject = subjectMatch[1].trim();
                  
                  if (target.generatedPitch.includes('Body:')) {
                    body = target.generatedPitch.split(/Body:\s*/)[1].trim();
                  } else {
                    body = target.generatedPitch.trim();
                  }
                }
                
                window.location.href = `mailto:${target.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
              }}
              style={{ borderColor: '#10b981', color: '#10b981' }}
            >
              <MessageSquare size={14} style={{ marginRight: '6px' }} />
              Email
            </button>
          )}
          <button 
            className="expand-btn"
            onClick={() => window.open(target.linkedinUrl, '_blank', 'noreferrer')}
            style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
          >
            <ExternalLink size={14} style={{ marginRight: '6px' }} />
            View Profile
          </button>
          <button 
            className={`expand-btn ${target.status === 'messaged' ? 'primary' : ''}`}
            onClick={() => handleStatusUpdate('messaged')}
            disabled={updating}
            style={target.status === 'messaged' ? { background: '#3b82f6', borderColor: '#3b82f6', color: '#fff' } : { borderColor: '#3b82f6', color: '#3b82f6' }}
          >
            <MessageSquare size={14} style={{ marginRight: '6px' }} />
            Messaged
          </button>
          <button 
            className={`expand-btn ${target.status === 'replied' ? 'primary' : ''}`}
            onClick={() => handleStatusUpdate('replied')}
            disabled={updating}
            style={target.status === 'replied' ? { background: '#10b981', borderColor: '#10b981', color: '#fff' } : { borderColor: '#10b981', color: '#10b981' }}
          >
            <Check size={14} style={{ marginRight: '6px' }} />
            Replied
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
