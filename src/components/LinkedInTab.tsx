import React, { useState } from 'react';
import { LinkedInPostsTab } from './LinkedInPostsTab';
import { OutreachTab } from './OutreachTab';

export function LinkedInTab() {
  const [outreachFilter, setOutreachFilter] = useState<'inbox' | 'archived'>('inbox');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '32px' }}>
      
      {/* Posts Copilot Section */}
      <div>
        <LinkedInPostsTab />
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />

      {/* Outreach CRM Section */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
          <div>
            <div className="section-label" style={{ color: 'var(--text)', marginBottom: '8px' }}>Outreach CRM</div>
            <p style={{ color: 'var(--muted)', fontSize: '13px' }}>
              Manage your direct outreach targets.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={`btn ${outreachFilter === 'inbox' ? 'btn-primary' : ''}`}
              onClick={() => setOutreachFilter('inbox')}
            >
              Inbox
            </button>
            <button
              className={`btn ${outreachFilter === 'archived' ? 'btn-primary' : ''}`}
              onClick={() => setOutreachFilter('archived')}
            >
              Archived
            </button>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <OutreachTab filter={outreachFilter} />
        </div>
      </div>

    </div>
  );
}
