import { hostnameMatches, parseHttpUrl } from './urlHost';

export const ATS_OPTIONS = [
  'Ashby', 'Avature', 'BambooHR', 'BrassRing', 'Breezy', 'Comeet', 'Dayforce', 'Greenhouse',
  'iCIMS', 'Lever', 'Oracle Cloud', 'Paycom', 'Paylocity', 'Personio', 'Phenom', 'Pinpoint', 'Recruitee', 'Rippling', 'Sage HR', 'SmartRecruiters', 'SuccessFactors', 'Taleo', 'Teamtailor',
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
  if (hasHost('comeet.com', 'comeet.co')) return 'Comeet';
  if (hasHost('taleo.net')) return 'Taleo';
  if (hasHost('icims.com')) return 'iCIMS';
  if (hasHost('smartrecruiters.com')) return 'SmartRecruiters';
  if (hasHost('bamboohr.com')) return 'BambooHR';
  if (hasHost('workable.com')) return 'Workable';
  if (hasHost('breezy.hr')) return 'Breezy';
  if (hasHost('teamtailor.com')) return 'Teamtailor';
  if (hasHost('recruitee.com')) return 'Recruitee';
  if (hasHost('pinpointhq.com')) return 'Pinpoint';
  if (hasHost('jobs.personio.de', 'jobs.personio.com')) return 'Personio';
  if (hasHost('oraclecloud.com')) return 'Oracle Cloud';
  if (hasHost('sage.hr')) return 'Sage HR';
  if (hasHost('brassring.com')) return 'BrassRing';
  if (hasHost('ultipro.com', 'ukg.com', 'saashr.com')) return 'UKG';
  if (hasHost('paylocity.com')) return 'Paylocity';
  if (hasHost('paycomonline.net')) return 'Paycom';
  if (hasHost('avature.net', 'apply.deloitte.com')) return 'Avature';
  if (hasHost('dayforce.com', 'dayforcehcm.com')) return 'Dayforce';
  // Stepan fronts SuccessFactors with an employer-owned vanity domain. Keep
  // this exact-host check narrow: the path shape alone is shared by many
  // unrelated career sites, while Stepan's apply/login flow is on sapsf.com.
  if (host === 'jobs.stepan.com' || hasHost('successfactors.com', 'sapsf.com', 'sapsf.eu')) return 'SuccessFactors';
  if (hasHost('rippling.com', 'rippling-ats.com')) return 'Rippling';
  if (hasHost('dzconnex.com')) return 'DZConneX';
  if (hasHost('ttcportals.com')) return 'Talemetry';
  if (hasHost('phenom.com', 'phenompeople.com') || parsedUrl?.searchParams.has('jobseqno')) return 'Phenom';

  return 'Unknown';
}

/**
 * Platforms whose listing endpoint lives on the board's own host.
 *
 * For these the URL carries the company -- `acme.myworkdayjobs.com`,
 * `acme.bamboohr.com` -- so the server answering is that employer's, not a
 * shared API we hold one credential for.
 *
 * This lives here, apart from both the acquisition and ingestion modules,
 * because both must reach the same verdict and neither can import the other:
 * ingestion owns the request boundary that sees the status code, acquisition
 * owns the failure classification, and they already form an import cycle.
 * Two copies of this list is how the two ended up disagreeing.
 */
export const ATS_PER_BOARD_HOST_PLATFORMS = new Set([
  'workday',
  'bamboohr',
  'breezy',
  'teamtailor',
  'pinpoint',
  'recruitee',
  'personio',
]);

/**
 * Whether a 401 or 403 is about our account or about the one board we asked.
 *
 * On a shared API a rejection is about the credential we call it with, so it
 * will say the same thing for every board and pausing the platform is right.
 * On a per-board host it is one employer's own server declining one request --
 * a closed board, a private tenant, a company that fenced its careers site --
 * and says nothing whatsoever about the next employer on the same platform.
 *
 * Treating the second as the first took all of Workday offline repeatedly on
 * 2026-09-02: a single board's 403 opened the platform circuit, which blocked
 * 3,249 batches across ~7,700 unrelated employers. Both machines could reach
 * Workday fine throughout -- the block was entirely self-inflicted.
 */
export function atsAuthFailureIsPlatformWide(platform?: string): boolean {
  return !platform || !ATS_PER_BOARD_HOST_PLATFORMS.has(platform);
}
