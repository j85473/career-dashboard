export const ATS_OPTIONS = [
  'Ashby', 'Avature', 'BambooHR', 'BrassRing', 'Dayforce', 'Greenhouse', 
  'iCIMS', 'Lever', 'Paycom', 'Paylocity', 'SmartRecruiters', 'SuccessFactors', 'Taleo', 
  'UKG', 'Unknown', 'Workable', 'Workday', 'ADP'
].sort((a, b) => {
  if (a === 'Unknown') return 1;
  if (b === 'Unknown') return -1;
  return a.localeCompare(b);
});

export function identifyAts(job: { url?: string; source?: string; manualAts?: string | null }): string {
  if (!job) return 'Unknown';
  if (job.manualAts) return job.manualAts;

  const url = (job.url || '').toLowerCase();
  const source = (job.source || '').toLowerCase();

  // If we directly ingested it via an ATS source tag
  if (source.startsWith('ats-')) {
    const parts = source.split('-');
    if (parts.length > 1) {
      const platform = parts[1];
      // Match against ATS_OPTIONS to get correct casing
      const matchedPlatform = ATS_OPTIONS.find(p => p.toLowerCase() === platform);
      if (matchedPlatform) return matchedPlatform;
      return platform.charAt(0).toUpperCase() + platform.slice(1);
    }
  }

  // Fallback to URL matching for jobs from SerpApi / Indeed / LinkedIn
  if (url.includes('myworkdayjobs.com') || url.includes('workday') || /\/job\/[a-f0-9]{32}(?:\/|$)/i.test(url)) return 'Workday';
  if (url.includes('adp.com') || url.includes('workforcenow')) return 'ADP';
  if (url.includes('greenhouse.io')) return 'Greenhouse';
  if (url.includes('lever.co')) return 'Lever';
  if (url.includes('ashbyhq.com')) return 'Ashby';
  if (url.includes('taleo.net')) return 'Taleo';
  if (url.includes('icims.com')) return 'iCIMS';
  if (url.includes('smartrecruiters.com')) return 'SmartRecruiters';
  if (url.includes('bamboohr.com')) return 'BambooHR';
  if (url.includes('workable.com')) return 'Workable';
  if (url.includes('brassring.com')) return 'BrassRing';
  if (url.includes('ultipro.com') || url.includes('ukg.com')) return 'UKG';
  if (url.includes('paylocity.com')) return 'Paylocity';
  if (url.includes('paycomonline.net')) return 'Paycom';
  if (url.includes('avature.net') || url.includes('apply.deloitte.com')) return 'Avature';
  if (url.includes('dayforce.com') || url.includes('dayforcehcm.com')) return 'Dayforce';
  if (url.includes('successfactors.com') || url.includes('sapsf.com') || url.includes('sapsf.eu')) return 'SuccessFactors';

  return 'Unknown';
}
