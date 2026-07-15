import React, { useState } from 'react';
import { OutreachExpandOverlay } from './OutreachExpandOverlay';

export interface OutreachTarget {
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

interface OutreachCardProps {
  target: OutreachTarget;
  onTargetUpdate: (id: string, updates: Partial<OutreachTarget>) => void;
}

export function OutreachCard({ target, onTargetUpdate }: OutreachCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Status Colors
  const statusColors: Record<string, string> = {
    inbox: 'var(--blue)',
    messaged: 'var(--accent)',
    replied: '#10b981',
    passed: 'var(--red)',
  };
  const statusColor = statusColors[target.status] ?? 'var(--muted)';

  const statusLabel = target.status.toUpperCase();

  return (
    <>
      <div 
        className="job-card" 
        style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
        onClick={() => setExpanded(true)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
          <div className="card-company">{target.company || 'Unknown Company'}</div>
          <div 
            className="status-badge" 
            style={{ 
              fontSize: '10px', 
              padding: '2px 6px', 
              borderRadius: '4px', 
              background: `${statusColor}20`,
              color: statusColor,
              fontWeight: 600
            }}
          >
            {statusLabel}
          </div>
        </div>
        
        <div className="card-title" style={{ fontSize: '16px', marginBottom: '4px' }}>
          {target.firstName} {target.lastName}
        </div>
        
        {target.email && (
          <div style={{ fontSize: '11px', color: 'var(--green)', marginBottom: '4px', fontWeight: 500 }}>
            📧 {target.email}
          </div>
        )}
        
        <div style={{ fontSize: '12px', color: 'var(--muted)', flex: 1, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {target.headline}
        </div>
      </div>

      {expanded && (
        <OutreachExpandOverlay 
          target={target} 
          onClose={() => setExpanded(false)} 
          onTargetUpdate={onTargetUpdate} 
        />
      )}
    </>
  );
}
