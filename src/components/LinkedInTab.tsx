import React from 'react';
import { LinkedInPostsTab } from './LinkedInPostsTab';
import { OutreachTab } from './OutreachTab';

interface LinkedInTabProps {
  activeSubTab: 'outreach' | 'posts';
}

export function LinkedInTab({ activeSubTab }: LinkedInTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1 }}>
        {activeSubTab === 'posts' ? <LinkedInPostsTab /> : <OutreachTab filter="inbox" />}
      </div>
    </div>
  );
}
