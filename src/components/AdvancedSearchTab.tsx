import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JobCard from './JobCard';
import type { JobListItem } from '@/types/job';
import {
  jobMatchesAdvancedStatuses,
  type AdvancedJobSearchField,
  type AdvancedJobSearchStatus,
} from '@/lib/advancedJobSearch';

interface Company {
  slug: string;
  platform: string;
  lastCheckedAt?: string | null;
}

interface PlatformSummary {
  name: string;
  count: number;
}

interface AdvancedSearchTabProps {
  onSelectJob: (job: JobListItem) => void;
  onJobUpdate: (id: string, updates: Partial<JobListItem>) => void;
}

interface JobSearchRequest {
  query: string;
  field: AdvancedJobSearchField;
  statuses: AdvancedJobSearchStatus[];
}

const SEARCH_FIELDS: Array<{ value: AdvancedJobSearchField; label: string; detail: string }> = [
  { value: 'all', label: 'Everything', detail: 'Titles, companies, descriptions, and IDs' },
  { value: 'title', label: 'Job titles', detail: 'Only words in the title' },
  { value: 'company', label: 'Company names', detail: 'Only employer names' },
  { value: 'description', label: 'Job descriptions', detail: 'Full-text JD search' },
];

const STATUS_FILTERS: Array<{ value: AdvancedJobSearchStatus; label: string }> = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'tailoring', label: 'Tailoring' },
  { value: 'pending_af', label: 'Scoring' },
  { value: 'applied', label: 'Applied' },
  { value: 'interviewing', label: 'Interviewing' },
  { value: 'cooldown', label: 'Cooldown' },
  { value: 'bookmarked', label: 'Bookmarked' },
  { value: 'archived', label: 'Archived' },
  { value: 'expired', label: 'Expired' },
  { value: 'passed', label: 'Passed' },
  { value: 'dismissed', label: 'Dismissed' },
];

const FIELD_PLACEHOLDERS: Record<AdvancedJobSearchField, string> = {
  all: 'Search titles, companies, job descriptions, or IDs…',
  title: 'Search job titles…',
  company: 'Search company names…',
  description: 'Search job descriptions…',
};

const BOARD_PAGE_SIZE = 80;

function boardLabel(company: Company): string {
  if (company.platform !== 'workday') return company.slug;
  const [host, site] = company.slug.split('::');
  return site ? `${host} · ${site}` : host;
}

function selectedPlatform(id: string): string {
  const lastSeparator = id.lastIndexOf('::');
  return lastSeparator < 0 ? '' : id.slice(lastSeparator + 2);
}

export function AdvancedSearchTab({ onSelectJob, onJobUpdate }: AdvancedSearchTabProps) {
  const [jobQuery, setJobQuery] = useState('');
  const [jobSearchField, setJobSearchField] = useState<AdvancedJobSearchField>('all');
  const [jobStatuses, setJobStatuses] = useState<Set<AdvancedJobSearchStatus>>(new Set());
  const [jobSearchResults, setJobSearchResults] = useState<JobListItem[] | null>(null);
  const [jobSearchPagination, setJobSearchPagination] = useState({ page: 1, total: 0, hasMore: false });
  const [jobSearchLoading, setJobSearchLoading] = useState(false);
  const [jobSearchError, setJobSearchError] = useState('');
  const [lastJobSearch, setLastJobSearch] = useState<JobSearchRequest | null>(null);
  const jobSearchAbortRef = useRef<AbortController | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [platformSummaries, setPlatformSummaries] = useState<PlatformSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadingPlatforms, setLoadingPlatforms] = useState<Set<string>>(new Set());
  const [selectingPlatforms, setSelectingPlatforms] = useState<Set<string>>(new Set());
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogMatches, setCatalogMatches] = useState<Company[] | null>(null);
  const [catalogSearching, setCatalogSearching] = useState(false);

  const [manualUrl, setManualUrl] = useState('');
  const [manualImporting, setManualImporting] = useState(false);

  const runJobSearch = useCallback(async (request: JobSearchRequest, page = 1, append = false) => {
    jobSearchAbortRef.current?.abort();
    const controller = new AbortController();
    jobSearchAbortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    setJobSearchLoading(true);
    setJobSearchError('');
    if (!append) setJobSearchResults(null);

    try {
      const params = new URLSearchParams({
        q: request.query,
        field: request.field,
        page: String(page),
        limit: '48',
      });
      if (request.statuses.length > 0) params.set('statuses', request.statuses.join(','));
      const response = await fetch(`/api/jobs/search?${params}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Search failed.');
      const nextJobs: JobListItem[] = data.jobs || [];
      setJobSearchResults((previous) => {
        if (!append) return nextJobs;
        const existingIds = new Set((previous || []).map((job) => job.id));
        return [...(previous || []), ...nextJobs.filter((job) => !existingIds.has(job.id))];
      });
      setJobSearchPagination(data.pagination || { page, total: 0, hasMore: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (timedOut) setJobSearchError('This search took too long. Try a more specific phrase or filter.');
        return;
      }
      console.error(error);
      setJobSearchError(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      window.clearTimeout(timeout);
      if (jobSearchAbortRef.current === controller) setJobSearchLoading(false);
    }
  }, []);

  useEffect(() => () => jobSearchAbortRef.current?.abort(), []);

  const applyResultUpdate = useCallback((id: string, updates: Partial<JobListItem>) => {
    setJobSearchResults((previous) => previous?.flatMap((job) => {
      if (job.id !== id) return [job];
      const nextJob = { ...job, ...updates };
      return jobMatchesAdvancedStatuses(nextJob, lastJobSearch?.statuses || []) ? [nextJob] : [];
    }) || previous);
  }, [lastJobSearch]);

  useEffect(() => {
    const handleDashboardJobUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; updates?: Partial<JobListItem> }>).detail;
      if (detail?.id && detail.updates) applyResultUpdate(detail.id, detail.updates);
    };
    window.addEventListener('dashboardJobUpdated', handleDashboardJobUpdate);
    return () => window.removeEventListener('dashboardJobUpdated', handleDashboardJobUpdate);
  }, [applyResultUpdate]);

  const handleJobSearchSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = jobQuery.trim();
    if (query.length < 2) return;
    const request: JobSearchRequest = {
      query,
      field: jobSearchField,
      statuses: [...jobStatuses],
    };
    setLastJobSearch(request);
    setJobSearchPagination({ page: 1, total: 0, hasMore: false });
    void runJobSearch(request);
  };

  const toggleJobStatus = (status: AdvancedJobSearchStatus) => {
    setJobStatuses((previous) => {
      const next = new Set(previous);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  useEffect(() => {
    fetch(`/api/ats-companies?overview=1&limit=${BOARD_PAGE_SIZE}`)
      .then(res => res.json())
      .then(data => {
        setCompanies(data.companies || []);
        setPlatformSummaries(data.platforms || []);
        setLoadError('');
        setLoading(false);
      })
      .catch(e => {
        console.error(e);
        setLoadError('Could not load the ATS company catalog.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const query = catalogQuery.trim();
    if (query.length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCatalogSearching(true);
      const params = new URLSearchParams({ q: query, limit: '500' });
      fetch(`/api/ats-companies?${params}`, { signal: controller.signal })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Could not search ATS endpoints.');
          setCatalogMatches(data.companies || []);
          setLoadError('');
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          console.error(error);
          setLoadError(error instanceof Error ? error.message : 'Could not search ATS endpoints.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setCatalogSearching(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [catalogQuery]);

  const handleToggle = (id: string) => {
    const next = new Set(selectedSlugs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedSlugs(next);
  };

  const handleSelectAll = async (platform: string) => {
    setSelectingPlatforms((previous) => new Set(previous).add(platform));
    try {
      const params = new URLSearchParams({
        platform,
        limit: '100000',
        identitiesOnly: '1',
      });
      const response = await fetch(`/api/ats-companies?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not select this platform.');
      setSelectedSlugs((previous) => {
        const next = new Set(previous);
        for (const company of data.companies || []) next.add(`${company.slug}::${company.platform}`);
        return next;
      });
    } catch (error) {
      console.error(error);
      setLoadError(error instanceof Error ? error.message : 'Could not select this platform.');
    } finally {
      setSelectingPlatforms((previous) => {
        const next = new Set(previous);
        next.delete(platform);
        return next;
      });
    }
  };

  const handleDeselectAll = (platform: string) => {
    setSelectedSlugs((previous) => new Set([...previous].filter((id) => selectedPlatform(id) !== platform)));
  };

  const loadMoreCompanies = async (platform: string, loaded: number) => {
    setLoadingPlatforms((previous) => new Set(previous).add(platform));
    try {
      const params = new URLSearchParams({
        platform,
        page: String(Math.floor(loaded / BOARD_PAGE_SIZE) + 1),
        limit: String(BOARD_PAGE_SIZE),
      });
      const response = await fetch(`/api/ats-companies?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load more companies.');
      setCompanies((previous) => {
        const existing = new Set(previous.map((company) => `${company.slug}::${company.platform}`));
        return [...previous, ...(data.companies || []).filter((company: Company) => !existing.has(`${company.slug}::${company.platform}`))];
      });
      setLoadError('');
    } catch (error) {
      console.error(error);
      setLoadError(error instanceof Error ? error.message : 'Could not load more companies.');
    } finally {
      setLoadingPlatforms((previous) => {
        const next = new Set(previous);
        next.delete(platform);
        return next;
      });
    }
  };

  const handleManualSearch = async () => {
    if (selectedSlugs.size === 0) return;
    
    const targetSlugs = Array.from(selectedSlugs).map(id => {
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
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        console.error(e);
        setSearchMessage('Search failed.');
      } else if (!(e instanceof Error)) {
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
        if (data.isDuplicate) {
          alert(`Duplicate detected!\n\n${data.job?.company || ''} - ${data.job?.title || ''} is already in your dashboard. We've staged the original record for tailoring!`);
        } else {
          alert(`Successfully imported: ${data.job?.company || ''} - ${data.job?.title || ''}!\n\nIt has been sent straight to your Inbox and is already staged for tailoring (plus queueing for Experience/Context scoring).`);
        }
        setManualUrl('');
      } else {
        alert(`Failed to import: ${data.error}`);
      }
    } catch(e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      alert(`Error importing: ${errorMsg}`);
    }
    setManualImporting(false);
  };

  // The server returns only the first bounded page for each platform. Further
  // rows are fetched per platform, so opening this tab no longer downloads the
  // entire ATS catalog before the manual-import input can respond.
  const displayedCompanies = catalogMatches ?? companies;
  const grouped = useMemo(() => displayedCompanies.reduce((acc, c) => {
    if (!acc[c.platform]) acc[c.platform] = [];
    acc[c.platform].push(c);
    return acc;
  }, {} as Record<string, Company[]>), [displayedCompanies]);

  const platforms = catalogMatches === null
    ? platformSummaries.map((platform) => platform.name)
    : [...new Set(catalogMatches.map((company) => company.platform))].sort();
  const platformTotals = Object.fromEntries(platformSummaries.map((platform) => [platform.name, platform.count]));

  return (
    <div className="advanced-search">
      <section className="panel advanced-job-search-panel">
        <div className="advanced-job-search-heading">
          <div>
            <span className="advanced-kicker">Search the whole Dashboard</span>
            <h2>Advanced Job Search</h2>
            <p>Choose exactly where to look, then narrow the results to one or more job queues.</p>
          </div>
          {lastJobSearch && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                jobSearchAbortRef.current?.abort();
                setJobQuery('');
                setJobSearchResults(null);
                setLastJobSearch(null);
                setJobSearchError('');
              }}
            >
              Clear results
            </button>
          )}
        </div>

        <form onSubmit={handleJobSearchSubmit}>
          <div className="advanced-query-row">
            <label htmlFor="advanced-job-query">Search terms</label>
            <div>
              <input
                id="advanced-job-query"
                type="search"
                className="feedback-input"
                placeholder={FIELD_PLACEHOLDERS[jobSearchField]}
                value={jobQuery}
                onChange={(event) => setJobQuery(event.target.value)}
                minLength={2}
                maxLength={200}
              />
              <button className="btn btn-primary" type="submit" disabled={jobQuery.trim().length < 2 || jobSearchLoading}>
                {jobSearchLoading ? 'Searching…' : 'Search jobs'}
              </button>
            </div>
          </div>

          <fieldset className="advanced-option-group">
            <legend>Search in</legend>
            <div className="advanced-field-options">
              {SEARCH_FIELDS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`advanced-field-option ${jobSearchField === option.value ? 'selected' : ''}`}
                  aria-pressed={jobSearchField === option.value}
                  onClick={() => setJobSearchField(option.value)}
                >
                  <strong>{option.label}</strong>
                  <span>{option.detail}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="advanced-option-group">
            <legend>Job queues</legend>
            <p>Select as many as you need. With no queue selected, the search covers every job.</p>
            <div className="advanced-status-options">
              <button
                type="button"
                className={`advanced-status-option ${jobStatuses.size === 0 ? 'selected' : ''}`}
                aria-pressed={jobStatuses.size === 0}
                onClick={() => setJobStatuses(new Set())}
              >
                All jobs
              </button>
              {STATUS_FILTERS.map((option) => (
                <label
                  key={option.value}
                  className={`advanced-status-option ${jobStatuses.has(option.value) ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={jobStatuses.has(option.value)}
                    onChange={() => toggleJobStatus(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        </form>
      </section>

      {lastJobSearch && (
        <section className="advanced-job-results" aria-busy={jobSearchLoading}>
          <div className="advanced-results-heading">
            <div>
              <span className="section-label">Search results</span>
              <strong>
                {jobSearchResults ? `${jobSearchResults.length} of ${jobSearchPagination.total}` : 'Searching'}
              </strong>
            </div>
            <p>
              {SEARCH_FIELDS.find((option) => option.value === lastJobSearch.field)?.label}
              {' · '}
              {lastJobSearch.statuses.length === 0
                ? 'All jobs'
                : lastJobSearch.statuses.map((status) => STATUS_FILTERS.find((option) => option.value === status)?.label || status).join(' + ')}
              {' · “'}{lastJobSearch.query}{'”'}
            </p>
          </div>

          {jobSearchError ? (
            <div className="inline-error" role="alert">
              {jobSearchError}
              <button className="btn" type="button" onClick={() => void runJobSearch(lastJobSearch)}>Try again</button>
            </div>
          ) : !jobSearchResults || (jobSearchLoading && jobSearchResults.length === 0) ? (
            <div className="advanced-results-state">Searching jobs…</div>
          ) : jobSearchResults.length === 0 ? (
            <div className="advanced-results-state">No jobs match this search and queue combination.</div>
          ) : (
            <>
              <div className="job-grid">
                {jobSearchResults.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onSelect={onSelectJob}
                    onJobUpdate={(id, updates) => {
                      applyResultUpdate(id, updates);
                      onJobUpdate(id, updates);
                    }}
                    showStatusBadge
                  />
                ))}
              </div>
              {jobSearchPagination.hasMore && (
                <div className="load-more-wrap">
                  <button
                    className="btn"
                    type="button"
                    disabled={jobSearchLoading}
                    onClick={() => void runJobSearch(lastJobSearch, jobSearchPagination.page + 1, true)}
                  >
                    {jobSearchLoading ? 'Loading…' : `Load more (${jobSearchPagination.total - jobSearchResults.length} remaining)`}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Manual Job Import</h2>
        <p>
          Paste a direct link to a job posting here. It will automatically parse the company & title, skip Aim Fit scoring, and process straight into your Inbox.
        </p>
        <div className="manual-import-row">
          <input 
            type="text" 
            className="feedback-input manual-import-input"
            placeholder="https://company.com/careers/job..." 
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
          />
          <button 
            className="btn btn-primary manual-import-button"
            onClick={handleManualImport}
            disabled={manualImporting || !manualUrl.trim()}
          >
            {manualImporting ? 'Processing...' : 'Import & Process'}
          </button>
        </div>
      </section>

      <div className="advanced-toolbar">
        <div>
          <h2>Run Selected ATS Boards ({selectedSlugs.size} selected)</h2>
          <p>Find company endpoints and run a manual ingestion search against only the boards you choose.</p>
          <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="search"
              className="feedback-input"
              placeholder="Find an ATS endpoint…"
              aria-label="Find an ATS endpoint"
              value={catalogQuery}
              onChange={(event) => {
                const value = event.target.value;
                setCatalogQuery(value);
                if (value.trim().length < 2) {
                  setCatalogMatches(null);
                  setCatalogSearching(false);
                }
              }}
              style={{ width: '280px', padding: '8px 10px' }}
            />
            {catalogSearching && <span style={{ color: 'var(--muted)', fontSize: '12px' }}>Searching…</span>}
          </div>
        </div>
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

      {loadError && <div className="list-error" role="alert" style={{ marginBottom: '16px' }}>{loadError}</div>}

      {loading ? (
        <div className="advanced-results-state">Loading ATS company catalog…</div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
        {platforms.map(platform => {
          const visibleCompanies = grouped[platform] || [];
          const hiddenRowCount = catalogMatches === null
            ? Math.max(0, (platformTotals[platform] || 0) - visibleCompanies.length)
            : 0;
          return (
          <div key={platform} style={{ background: 'var(--bg-card)', padding: '15px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 style={{ margin: 0, textTransform: 'capitalize' }}>{platform}</h3>
              <div style={{ display: 'flex', gap: '10px', fontSize: '12px' }}>
                <button
                  onClick={() => void handleSelectAll(platform)}
                  disabled={selectingPlatforms.has(platform)}
                  style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}
                >
                  {selectingPlatforms.has(platform) ? 'Loading…' : 'All'}
                </button>
                <button onClick={() => handleDeselectAll(platform)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0 }}>None</button>
              </div>
            </div>
            
            <div style={{ maxHeight: '300px', overflowY: 'auto', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
              {visibleCompanies.map((c: Company) => {
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
                    <span title={c.slug} style={{ fontSize: '14px', wordBreak: 'break-all' }}>
                      {boardLabel(c)}
                    </span>
                    {recentlyChecked && (
                      <span title="Checked in last 24hrs" style={{ fontSize: '12px' }}>⚠️</span>
                    )}
                  </label>
                );
              })}
              {hiddenRowCount > 0 && (
                <button
                  className="advanced-show-more"
                  disabled={loadingPlatforms.has(platform)}
                  onClick={() => void loadMoreCompanies(platform, visibleCompanies.length)}
                >
                  {loadingPlatforms.has(platform)
                    ? 'Loading…'
                    : `Show ${Math.min(BOARD_PAGE_SIZE, hiddenRowCount)} more (${hiddenRowCount.toLocaleString()} remaining)`}
                </button>
              )}
            </div>
          </div>
          );
        })}
      </div>
      )}
      {catalogMatches !== null && !catalogSearching && catalogMatches.length === 0 && (
        <div className="list-error" role="status">No ATS endpoints match “{catalogQuery.trim()}”.</div>
      )}
    </div>
  );
}
