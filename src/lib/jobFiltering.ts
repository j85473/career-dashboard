export function passesPreFilter(job: { title: string, description: string, location: string, url: string, company: string }): { passes: boolean, reason: string } {
  if (!job.title || !job.company) return { passes: false, reason: 'Missing title or company' };

  const titleLower = job.title.toLowerCase();
  const descLower = job.description ? job.description.toLowerCase() : '';

  // 1. Check for Part Time
  if (/\bpart[-\s]?time\b/.test(titleLower) || /\bPT\b/.test(job.title) || /\(PT\)/i.test(job.title) || /\bpart[-\s]?time\b/.test(descLower)) {
    return { passes: false, reason: 'Part-time role rejected' };
  }

  // 2. Check for 1099 / Contract
  if (/\b1099\b/.test(titleLower) || /\bcontract\b/.test(titleLower) || /\bcontractor\b/.test(titleLower) || /\b1099\b/.test(descLower)) {
    return { passes: false, reason: 'Contract/1099 role rejected' };
  }

  // 3. Check for Inside Sales
  if (/\binside sales\b/.test(titleLower)) {
    return { passes: false, reason: 'Inside Sales role rejected' };
  }

  // 4. Check for Retail Specific / Entry Level
  if (/\bretail\b/.test(titleLower) && !/\b(manager|director|vp)\b/.test(titleLower)) {
    return { passes: false, reason: 'Retail role rejected' };
  }
  if (/\bentry[-\s]?level\b/.test(titleLower)) {
    return { passes: false, reason: 'Entry Level role rejected' };
  }

  return { passes: true, reason: 'Passed regex pre-filter' };
}
