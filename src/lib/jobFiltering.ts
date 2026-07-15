export function passesPreFilter(job: { title: string, description: string, location: string, url: string, company: string }): { passes: boolean, reason: string } {
  if (!job.title || !job.company) return { passes: false, reason: 'Missing title or company' };

  const titleLower = job.title.toLowerCase();
  const descLower = job.description ? job.description.toLowerCase() : '';

  // Location feeds are inconsistent: many remote jobs say only "United States"
  // in the location field and put the remote signal in the title/JD. Reject only
  // when we have a clear, non-target location; unknown locations stay eligible.
  const locationLower = job.location ? job.location.toLowerCase() : '';
  const targetLocation = /\b(mn|minnesota|minneapolis|st\.?\s*paul|saint paul|remote|flexible|worldwide|anywhere|nationwide|united states|u\.?s\.?)\b/;
  const remoteEvidence = /\b(remote|work from home|work[- ]from[- ]anywhere|distributed|nationwide)\b/;
  const locationUnknown = !locationLower || /^(unknown|n\/a|not specified|multiple locations?)$/i.test(locationLower.trim());
  if (!locationUnknown && !targetLocation.test(locationLower) && !remoteEvidence.test(`${titleLower} ${descLower}`)) {
    return { passes: false, reason: `Location rejected (${job.location})` };
  }

  // Explicit employment-type exclusions are deterministic enough to handle
  // locally. Ambiguous mentions in the body are left for the scorer.
  if (/\bpart[-\s]?time\b/.test(titleLower) || /\bPT\b/.test(job.title) || /\(PT\)/i.test(job.title) || /(?:employment|job)\s*type\s*:?\s*part[-\s]?time/i.test(descLower)) {
    return { passes: false, reason: 'Part-time role rejected' };
  }

  // Check for 1099 / Contract
  if (/\b1099\b/.test(titleLower) || /\bcontract\b/.test(titleLower) || /\bcontractor\b/.test(titleLower) || /(?:employment|job)\s*type\s*:?\s*(?:1099|contract(?:or)?)/i.test(descLower)) {
    return { passes: false, reason: 'Contract/1099 role rejected' };
  }

  // Check for Inside Sales
  if (/\binside sales\b/.test(titleLower)) {
    return { passes: false, reason: 'Inside Sales role rejected' };
  }

  // Check for Retail Specific / Entry Level
  if (/\bretail\b/.test(titleLower) && !/\b(manager|director|vp)\b/.test(titleLower)) {
    return { passes: false, reason: 'Retail role rejected' };
  }
  if (/\bentry[-\s]?level\b/.test(titleLower)) {
    return { passes: false, reason: 'Entry Level role rejected' };
  }

  return { passes: true, reason: 'Passed regex pre-filter' };
}
