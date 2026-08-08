import { hostnameMatches, parseHttpUrl } from './urlHost';

export const ATS_OPTIONS = [
  'Ashby', 'Avature', 'BambooHR', 'BrassRing', 'Breezy', 'Dayforce', 'Greenhouse', 
  'iCIMS', 'Lever', 'Oracle Cloud', 'Paycom', 'Paylocity', 'Phenom', 'Pinpoint', 'Recruitee', 'Rippling', 'Sage HR', 'SmartRecruiters', 'SuccessFactors', 'Taleo', 
  'UKG', 'Unknown', 'Workable', 'Workday', 'ADP', 'DZConneX', 'Talemetry'
].sort((a, b) => {
  if (a === 'Unknown') return 1;
  if (b === 'Unknown') return -1;
  return a.localeCompare(b);
});

export function identifyAts(job: { url?: string | null; source?: string | null; manualAts?: string | null }): string {
  if (!job) return 'Unknown';
  if (job.manualAts && !/^unknown(?:\s+ats)?$/i.test(job.manualAts.trim())) return job.manualAts;

  const parsedUrl = parseHttpUrl(job.url);
  const host = parsedUrl?.hostname.toLowerCase() || '';
  const pathname = parsedUrl?.pathname || '';
  const hasHost = (...domains: string[]) => domains.some((domain) => hostnameMatches(host, domain));
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
  if (hasHost('myworkdayjobs.com', 'workday.com') || /\/job\/[a-f0-9]{32}(?:\/|$)/i.test(pathname)) return 'Workday';
  if (hasHost('adp.com')) return 'ADP';
  if (hasHost('greenhouse.io') || parsedUrl?.searchParams.has('gh_jid')) return 'Greenhouse';
  if (hasHost('lever.co')) return 'Lever';
  if (hasHost('ashbyhq.com')) return 'Ashby';
  if (hasHost('taleo.net')) return 'Taleo';
  if (hasHost('icims.com')) return 'iCIMS';
  if (hasHost('smartrecruiters.com')) return 'SmartRecruiters';
  if (hasHost('bamboohr.com')) return 'BambooHR';
  if (hasHost('workable.com')) return 'Workable';
  if (hasHost('breezy.hr')) return 'Breezy';
  if (hasHost('recruitee.com')) return 'Recruitee';
  if (hasHost('pinpointhq.com')) return 'Pinpoint';
  if (hasHost('oraclecloud.com')) return 'Oracle Cloud';
  if (hasHost('sage.hr')) return 'Sage HR';
  if (hasHost('brassring.com')) return 'BrassRing';
  if (hasHost('ultipro.com', 'ukg.com', 'saashr.com')) return 'UKG';
  if (hasHost('paylocity.com')) return 'Paylocity';
  if (hasHost('paycomonline.net')) return 'Paycom';
  if (hasHost('avature.net', 'apply.deloitte.com')) return 'Avature';
  if (hasHost('dayforce.com', 'dayforcehcm.com')) return 'Dayforce';
  if (hasHost('successfactors.com', 'sapsf.com', 'sapsf.eu')) return 'SuccessFactors';
  if (hasHost('rippling.com', 'rippling-ats.com')) return 'Rippling';
  if (hasHost('dzconnex.com')) return 'DZConneX';
  if (hasHost('ttcportals.com')) return 'Talemetry';
  if (hasHost('phenom.com', 'phenompeople.com') || parsedUrl?.searchParams.has('jobseqno')) return 'Phenom';

  return 'Unknown';
}
