import React, { useState } from 'react';
import { LinkedInPostsTab } from './LinkedInPostsTab';
import { OutreachTab } from './OutreachTab';

export function LinkedInTab() {
  const [activeSubTab, setActiveSubTab] = useState<'posts' | 'outreach' | 'outreach_archived'>('outreach');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="sub-topbar" style={{ position: 'relative', zIndex: 199, background: 'var(--card)', borderBottom: '1px solid var(--border)', padding: '0 28px', display: 'flex', gap: '16px', height: '44px', alignItems: 'center', margin: '0 0 24px 0', width: '100%' }}>
        <button
          className={`nav-tab ${activeSubTab === 'outreach' ? 'active-sub' : ''}`}
          onClick={() => setActiveSubTab('outreach')}
          style={{
            textTransform: 'capitalize',
            fontSize: '12px',
            color: activeSubTab === 'outreach' ? 'var(--text)' : 'var(--muted)'
          }}
        >
          Outreach CRM
        </button>
        <button
          className={`nav-tab ${activeSubTab === 'outreach_archived' ? 'active-sub' : ''}`}
          onClick={() => setActiveSubTab('outreach_archived')}
          style={{
            textTransform: 'capitalize',
            fontSize: '12px',
            color: activeSubTab === 'outreach_archived' ? 'var(--text)' : 'var(--muted)'
          }}
        >
          Archived Targets
        </button>
        <button
          className={`nav-tab ${activeSubTab === 'posts' ? 'active-sub' : ''}`}
          onClick={() => setActiveSubTab('posts')}
          style={{
            textTransform: 'capitalize',
            fontSize: '12px',
            color: activeSubTab === 'posts' ? 'var(--text)' : 'var(--muted)'
          }}
        >
          Posts Copilot
        </button>
      </div>

      <div style={{ flex: 1 }}>
        {activeSubTab === 'posts' ? <LinkedInPostsTab /> : activeSubTab === 'outreach_archived' ? <OutreachTab filter="archived" /> : <OutreachTab filter="inbox" />}
      </div>
    </div>
  );
}
