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

/**
 * Platforms confirmed to answer an unknown tenant with an off-host 429.
 *
 * Personio serves a nonexistent subdomain by redirecting to `personio.com` and
 * returning its marketing page under HTTP 429. Read as a rate limit that is
 * false twice over: nothing was throttled, and the response is not about
 * pacing at all -- it is the vendor saying the board does not exist.
 *
 * Probed directly on 2026-09-03, three seconds apart, with live boards
 * interleaved as a control: eight boards that had never responded in the 18
 * days since discovery all returned 429 from `personio.com`, while five
 * known-good boards all returned HTTP 200 and real XML from their own hosts.
 * A genuine throttle would have taken the controls too.
 *
 * Deliberately a set of one. Six other platforms host boards on their own
 * subdomains and may well do something similar, but only Personio has been
 * observed doing it, and a board is retired on this evidence. Add a platform
 * here only after probing it the same way.
 */
export const ATS_OFF_HOST_RATE_LIMIT_PLATFORMS = new Set(['personio']);

/**
 * Whether a response came back from somewhere other than the address asked.
 *
 * The board's own host is the whole identity of a per-board-host listing
 * endpoint, so an answer from anywhere else is not that board answering,
 * whatever status it carries. An unparseable URL is not evidence of anything
 * and reports false.
 */
export function atsResponseRedirectedOffHost(
  requestedUrl: string,
  respondedUrl: string | null | undefined,
): boolean {
  if (!respondedUrl) return false;
  try {
    return new URL(respondedUrl).host !== new URL(requestedUrl).host;
  } catch {
    return false;
  }
}

/**
 * Whether a 429 is the vendor disowning the board rather than throttling us.
 *
 * Requires both the confirmed platform and an off-host answer. A 429 from the
 * board's own address is a real rate limit and keeps its ordinary handling.
 */
export function atsRateLimitIsAbsentBoard(input: {
  platform: string;
  requestedUrl: string;
  respondedUrl: string | null | undefined;
}): boolean {
  return ATS_OFF_HOST_RATE_LIMIT_PLATFORMS.has(input.platform)
    && atsResponseRedirectedOffHost(input.requestedUrl, input.respondedUrl);
}

/**
 * Platforms where a rate limit is one employer's server, not the vendor's.
 *
 * On a shared API a 429 is about the credential we call with, so it will say
 * the same thing for every board and pausing the platform is right. On a
 * per-board host there is no shared credential -- `acme.jobs.personio.de` is
 * Acme's own server -- and pausing the vendor because one employer said "not
 * this fast" stops every other employer on it.
 *
 * Measured on 2026-09-03: refusals and successes on different Personio boards
 * landed inside the same minute (eight refused, one served at 18:51), which a
 * platform-wide limit cannot produce. The refusal rate also moved *against*
 * our request rate -- 3% while making 678 calls an hour, 100% while making
 * almost none -- so it was never about our pacing at all.
 *
 * A set of one for the same reason as the off-host list: only Personio has
 * been measured. The six other per-board hosts are very likely the same and
 * are deliberately left alone until each is confirmed.
 */
export const ATS_PER_BOARD_RATE_LIMIT_PLATFORMS = new Set(['personio']);

/** Whether a 429 speaks for one board rather than the whole platform. */
export function atsRateLimitIsBoardScoped(platform?: string): boolean {
  return Boolean(platform) && ATS_PER_BOARD_RATE_LIMIT_PLATFORMS.has(platform as string);
}
