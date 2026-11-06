import { jobLocationPresentation } from '@/lib/jobLocationPresentation';

export function JobLocations({ location }: { location: string | null | undefined }) {
  const { locations, summary, expandable } = jobLocationPresentation(location);
  if (!expandable) return <div className="job-locations">{summary}</div>;

  return (
    <details className="job-locations">
      <summary>{summary} <span className="job-locations-toggle">· View {locations.length > 1 ? 'all locations' : 'full location'}</span></summary>
      <div className="job-locations-list" role="region" aria-label="All listed job locations" tabIndex={0}>
        <ul>{locations.map((value, index) => <li key={index}>{value}</li>)}</ul>
      </div>
    </details>
  );
}
