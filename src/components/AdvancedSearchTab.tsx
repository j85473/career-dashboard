import React, { useState, useEffect } from 'react';

export function AdvancedSearchTab() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const [manualUrl, setManualUrl] = useState('');
  const [manualImporting, setManualImporting] = useState(false);

  useEffect(() => {
    fetch('/api/ats-companies')
      .then(res => res.json())
      .then(data => {
        setCompanies(data.companies || []);
        setLoading(false);
      })
      .catch(e => {
        console.error(e);
        setLoading(false);
      });
  }, []);

  const handleToggle = (id: string) => {
    const next = new Set(selectedSlugs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedSlugs(next);
  };

  const handleSelectAll = (platform: string) => {
    const platformSlugs = companies.filter(c => c.platform === platform).map(c => `${c.slug}::${c.platform}`);
    const next = new Set(selectedSlugs);
    platformSlugs.forEach(id => next.add(id));
    setSelectedSlugs(next);
  };

  const handleDeselectAll = (platform: string) => {
    const platformSlugs = companies.filter(c => c.platform === platform).map(c => `${c.slug}::${c.platform}`);
    const next = new Set(selectedSlugs);
    platformSlugs.forEach(id => next.delete(id));
    setSelectedSlugs(next);
  };

  const handleManualSearch = async () => {
    if (selectedSlugs.size === 0) return;
    
    const targetSlugs = Array.from(selectedSlugs).map(id => {
      const [slug, platform] = id.split('::');
      // If workday, it has its own :: inside the slug, so we split by the LAST :: 
      // Actually we should encode it safely or just use an object
      const lastIdx = id.lastIndexOf('::');
      return {
        slug: id.substring(0, lastIdx),
        platform: id.substring(lastIdx + 2)
      };
    });

    const controller = new AbortController();
    setAbortController(controller);
    setSearchLoading(true);
    setSearchMessage('Starting manual search...');

    try {
      const res = await fetch('/api/ats-search', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs: targetSlugs }),
        signal: controller.signal
      });
      
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let buffer = '';

      while (!done && reader) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n\n')) >= 0) {
            const eventStr = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 2);
            if (eventStr.startsWith('data: ')) {
              try {
                const data = JSON.parse(eventStr.slice(6));
                setSearchMessage(data.message);
              } catch(e) {}
            }
          }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        console.error(e);
        setSearchMessage('Search failed.');
      }
    }
    setSearchLoading(false);
  };

  const cancelSearch = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
  };

  const handleManualImport = async () => {
    if (!manualUrl.trim()) return;
    setManualImporting(true);
    try {
      const res = await fetch('/api/jobs/manual-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: manualUrl.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        alert(`Successfully imported: ${data.job.company} - ${data.job.title}!\n\nIt has been sent straight to your Inbox and is already queueing for Experience and Context batch scoring.`);
        setManualUrl('');
      } else {
        alert(`Failed to import: ${data.error}`);
      }
    } catch(e: any) {
      alert(`Error importing: ${e.message}`);
    }
    setManualImporting(false);
  };

  if (loading) return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading companies...</div>;

  const grouped = companies.reduce((acc, c) => {
    if (!acc[c.platform]) acc[c.platform] = [];
    acc[c.platform].push(c);
    return acc;
  }, {} as Record<string, any[]>);

  const platforms = Object.keys(grouped).sort();

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', padding: '20px', borderRadius: '8px', border: '1px solid var(--border)', marginBottom: '30px' }}>
        <h2 style={{ marginTop: 0, marginBottom: '8px' }}>Manual Job Import</h2>
        <p style={{ color: 'var(--muted)', fontSize: '14px', marginBottom: '16px', marginTop: 0 }}>
          Paste a direct link to a job posting here. It will automatically parse the company & title, skip Aim Fit scoring, and process straight into your Inbox.
        </p>
        <div style={{ display: 'flex', gap: '12px' }}>
          <input 
            type="text" 
            className="feedback-input" 
            placeholder="https://company.com/careers/job..." 
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            style={{ flex: 1, padding: '10px 14px', fontSize: '15px' }}
          />
          <button 
            className="btn btn-primary" 
            onClick={handleManualImport}
            disabled={manualImporting || !manualUrl.trim()}
            style={{ padding: '10px 24px' }}
          >
            {manualImporting ? 'Processing...' : 'Import & Process'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderTop: '1px solid var(--border)', paddingTop: '30px' }}>
        <h2 style={{ margin: 0 }}>Advanced Search ({selectedSlugs.size} selected)</h2>
        <div>
          {searchLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ color: 'var(--primary)' }}>{searchMessage}</span>
              <button className="btn btn-danger" onClick={cancelSearch}>Stop Search</button>
            </div>
          ) : (
            <button 
              className="btn btn-primary" 
              onClick={handleManualSearch}
              disabled={selectedSlugs.size === 0}
            >
              Manual Search
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
        {platforms.map(platform => (
          <div key={platform} style={{ background: 'var(--bg-card)', padding: '15px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 style={{ margin: 0, textTransform: 'capitalize' }}>{platform}</h3>
              <div style={{ display: 'flex', gap: '10px', fontSize: '12px' }}>
                <button onClick={() => handleSelectAll(platform)} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}>All</button>
                <button onClick={() => handleDeselectAll(platform)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0 }}>None</button>
              </div>
            </div>
            
            <div style={{ maxHeight: '300px', overflowY: 'auto', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
              {grouped[platform].map((c: any) => {
                const id = `${c.slug}::${c.platform}`;
                const checked = selectedSlugs.has(id);
                
                // 24 hour indicator
                let recentlyChecked = false;
                if (c.platform === 'workday' && c.lastCheckedAt) {
                  const hoursSince = (Date.now() - new Date(c.lastCheckedAt).getTime()) / (1000 * 60 * 60);
                  if (hoursSince < 24) {
                    recentlyChecked = true;
                  }
                }

                return (
                  <label key={id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', cursor: 'pointer' }}>
                    <input 
                      type="checkbox" 
                      checked={checked} 
                      onChange={() => handleToggle(id)} 
                    />
                    <span style={{ fontSize: '14px', wordBreak: 'break-all' }}>
                      {c.platform === 'workday' ? c.slug.split('::')[0] : c.slug}
                    </span>
                    {recentlyChecked && (
                      <span title="Checked in last 24hrs" style={{ fontSize: '12px' }}>⚠️</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
