import React, { useState, useEffect } from 'react';
import { Loader, UploadCloud, RefreshCw } from 'lucide-react';
import { OutreachCard, type OutreachTarget } from './OutreachCard';

async function requestTargets(signal?: AbortSignal): Promise<OutreachTarget[]> {
  const response = await fetch('/api/outreach', { signal });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to load outreach targets.');
  }
  return Array.isArray(data.targets) ? data.targets : [];
}

export function OutreachTab({ filter = 'inbox' }: { filter?: 'inbox' | 'archived' }) {
  const [targets, setTargets] = useState<OutreachTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchTargets = async () => {
    setLoading(true);
    try {
      setTargets(await requestTargets());
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    const controller = new AbortController();

    requestTargets(controller.signal)
      .then(setTargets)
      .catch(error => {
        if (!controller.signal.aborted) console.error(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, []);

  const handleSyncApify = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/outreach/apify-sync', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        alert(`Successfully synced with Apify! Found ${data.profilesFetched} profiles. Added ${data.newProfilesInserted} new targets.`);
        fetchTargets();
      } else {
        alert("Failed to sync with Apify: " + (data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error(err);
      alert("An error occurred while syncing with Apify.");
    }
    setSyncing(false);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await fetch('/api/outreach/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        alert("Profiles imported successfully!");
        fetchTargets();
      } else {
        alert("Failed to import profiles.");
      }
    } catch (err) {
      console.error(err);
      alert("Invalid JSON file.");
    }
    e.target.value = '';
  };

  const handleTargetUpdate = (id: string, updates: Partial<OutreachTarget>) => {
    setTargets(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const displayTargets = targets.filter(t => {
    if (filter === 'inbox') {
      return !['messaged', 'replied', 'passed'].includes(t.status);
    } else {
      return ['messaged', 'replied', 'passed'].includes(t.status);
    }
  });

  return (
    <div style={{ padding: '0 28px', marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <div className="section-label" style={{ color: 'var(--text)', marginBottom: '8px' }}>
            {filter === 'inbox' ? 'Targeted Outreach' : 'Archived Outreach'}
          </div>
          <p style={{ color: 'var(--muted)', fontSize: '13px' }}>
            {filter === 'inbox' 
              ? 'Manage scraped profiles, track your pipeline, and generate customized cold pitches.' 
              : 'View profiles you have already messaged, replied to, or passed on.'}
          </p>
        </div>
        
        {filter === 'inbox' && (
          <div style={{ display: 'flex', gap: '12px' }}>
            <button 
              className="btn btn-secondary" 
              onClick={handleSyncApify}
              disabled={syncing}
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              {syncing ? <Loader className="spin" size={16} /> : <RefreshCw size={16} />}
              {syncing ? 'Syncing...' : 'Sync Apify API'}
            </button>
            
            <input 
              type="file" 
              accept=".json" 
              id="import-outreach-json" 
              style={{ display: 'none' }} 
              onChange={handleImport}
            />
            <button 
              className="btn btn-primary" 
              onClick={() => document.getElementById('import-outreach-json')?.click()}
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <UploadCloud size={16} /> Import JSON
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>
          <Loader className="spin" size={24} style={{ margin: '0 auto' }} />
        </div>
      ) : displayTargets.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
          {filter === 'inbox' ? 'No targets found. Sync with Apify or import a JSON file to get started.' : 'No archived targets yet.'}
        </div>
      ) : (
        <div className="job-grid">
          {displayTargets.map(target => (
            <OutreachCard 
              key={target.id} 
              target={target} 
              onTargetUpdate={handleTargetUpdate} 
            />
          ))}
        </div>
      )}
    </div>
  );
}
