'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { showAlert } from '@/lib/modal';

interface AtsCompany {
  slug: string;
  platform: string;
  lastCheckedAt: string | null;
}

interface AtsPlatform {
  name: string;
  count: number;
}

export function AdvancedSearchTab() {
  const [companies, setCompanies] = useState<AtsCompany[]>([]);
  const [platforms, setPlatforms] = useState<AtsPlatform[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1, hasMore: false });
  const [companyQuery, setCompanyQuery] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const companyAbortRef = useRef<AbortController | null>(null);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const searchAbortRef = useRef<AbortController | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [manualImporting, setManualImporting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      companyAbortRef.current?.abort();
      const controller = new AbortController();
      companyAbortRef.current = controller;
      setLoading(true);
      setLoadError('');
      try {
        const params = new URLSearchParams({ page: String(pagination.page), limit: '100' });
        if (companyQuery.trim()) params.set('q', companyQuery.trim());
        if (platformFilter) params.set('platform', platformFilter);
        const res = await fetch(`/api/ats-companies?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error('Could not load ATS companies.');
        const data = await res.json();
        setCompanies(data.companies || []);
        setPlatforms(data.platforms || []);
        setPagination((previous) => ({ ...previous, ...data.pagination }));
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setLoadError(reason instanceof Error ? reason.message : 'Could not load ATS companies.');
      } finally {
        if (companyAbortRef.current === controller) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      companyAbortRef.current?.abort();
    };
  }, [companyQuery, platformFilter, pagination.page]);

  const grouped = useMemo(() => companies.reduce<Record<string, AtsCompany[]>>((groups, company) => {
    (groups[company.platform] ||= []).push(company);
    return groups;
  }, {}), [companies]);

  const companyKey = (company: AtsCompany) => `${company.slug}::${company.platform}`;
  const handleToggle = (id: string) => {
    setSelectedSlugs((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectVisible = () => setSelectedSlugs((previous) => {
    const next = new Set(previous);
    companies.forEach((company) => next.add(companyKey(company)));
    return next;
  });
  const deselectVisible = () => setSelectedSlugs((previous) => {
    const next = new Set(previous);
    companies.forEach((company) => next.delete(companyKey(company)));
    return next;
  });

  const handleManualSearch = async () => {
    if (selectedSlugs.size === 0) return;
    const targets = Array.from(selectedSlugs).map((id) => {
      const separator = id.lastIndexOf('::');
      return { slug: id.substring(0, separator), platform: id.substring(separator + 2) };
    });
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchLoading(true);
    setSearchMessage('Starting manual search…');
    try {
      const res = await fetch('/api/ats-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs: targets }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Manual search could not be started.');
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const event = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (event.startsWith('data: ')) {
            const data = JSON.parse(event.slice(6));
            setSearchMessage(data.message || data.error || 'Processing…');
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setSearchMessage(reason instanceof Error ? reason.message : 'Search failed.');
      }
    } finally {
      setSearchLoading(false);
      searchAbortRef.current = null;
    }
  };

  const handleManualImport = async () => {
    if (!manualUrl.trim()) return;
    setManualImporting(true);
    try {
      const res = await fetch('/api/jobs/manual-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: manualUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The job could not be imported.');
      if (data.isDuplicate) {
        await showAlert(`${data.job?.company || 'This job'} is already in the dashboard. The existing record was staged for tailoring.`);
      } else {
        await showAlert(`${data.job?.company || 'The job'} — ${data.job?.title || ''} was imported and added to the scoring queue.`);
      }
      setManualUrl('');
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'The job could not be imported.');
    } finally {
      setManualImporting(false);
    }
  };

  return (
    <div className="advanced-search">
      <section className="panel">
        <h2>Manual Job Import</h2>
        <p>Paste a direct job-posting link. The job description will be extracted and the record will be added to the normal scoring queue.</p>
        <div className="input-row">
          <input type="url" className="feedback-input" placeholder="https://company.com/careers/job…" value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} />
          <button className="btn btn-primary" onClick={handleManualImport} disabled={manualImporting || !manualUrl.trim()}>
            {manualImporting ? 'Processing…' : 'Import & process'}
          </button>
        </div>
      </section>

      <section className="advanced-toolbar">
        <div>
          <h2>Advanced Search</h2>
          <p>{selectedSlugs.size} selected · {pagination.total.toLocaleString()} matching boards</p>
        </div>
        <div className="advanced-actions">
          {searchLoading ? (
            <><span aria-live="polite">{searchMessage}</span><button className="btn btn-danger" onClick={() => searchAbortRef.current?.abort()}>Stop search</button></>
          ) : (
            <button className="btn btn-primary" onClick={handleManualSearch} disabled={selectedSlugs.size === 0}>Search selected boards</button>
          )}
        </div>
      </section>

      <div className="ats-filters">
        <input type="search" className="feedback-input" placeholder="Filter company slugs…" value={companyQuery} onChange={(event) => { setCompanyQuery(event.target.value); setPagination((previous) => ({ ...previous, page: 1 })); }} />
        <select value={platformFilter} onChange={(event) => { setPlatformFilter(event.target.value); setPagination((previous) => ({ ...previous, page: 1 })); }}>
          <option value="">All platforms</option>
          {platforms.map((platform) => <option key={platform.name} value={platform.name}>{platform.name} ({platform.count.toLocaleString()})</option>)}
        </select>
        <button className="btn" onClick={selectVisible} disabled={companies.length === 0}>Select page</button>
        <button className="btn" onClick={deselectVisible} disabled={companies.length === 0}>Clear page</button>
      </div>

      {loadError ? <div className="inline-error" role="alert">{loadError}</div>
        : loading ? <div className="empty-state">Loading companies…</div>
        : companies.length === 0 ? <div className="empty-state">No ATS boards match those filters.</div>
        : <div className="ats-grid">
          {Object.entries(grouped).map(([platform, entries]) => (
            <section className="ats-group" key={platform}>
              <h3>{platform}</h3>
              <div className="ats-list">
                {entries.map((company) => {
                  const id = companyKey(company);
                  const checkedRecently = company.lastCheckedAt && Date.now() - new Date(company.lastCheckedAt).getTime() < 86_400_000;
                  return (
                    <label key={id}>
                      <input type="checkbox" checked={selectedSlugs.has(id)} onChange={() => handleToggle(id)} />
                      <span>{company.platform === 'workday' ? company.slug.split('::')[0] : company.slug}</span>
                      {checkedRecently && <span title="Checked in the last 24 hours" aria-label="Checked in the last 24 hours">•</span>}
                    </label>
                  );
                })}
              </div>
            </section>
          ))}
        </div>}

      <div className="pagination-controls" aria-label="ATS company pages">
        <button className="btn" disabled={pagination.page <= 1 || loading} onClick={() => setPagination((previous) => ({ ...previous, page: previous.page - 1 }))}>Previous</button>
        <span>Page {pagination.page} of {pagination.totalPages}</span>
        <button className="btn" disabled={!pagination.hasMore || loading} onClick={() => setPagination((previous) => ({ ...previous, page: previous.page + 1 }))}>Next</button>
      </div>
    </div>
  );
}
