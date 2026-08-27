/**
 * Which ATS boards are worth their place in the weekly rotation.
 *
 * Board sweep cost is paid per *posting*, not per board, and the distribution
 * is extremely skewed: the average active board carries 11 postings while a
 * handful carry two to three thousand. At the August 25 measurement, 38 boards
 * held 8.8% of all postings, and the ten largest had produced two surviving
 * jobs between them out of roughly eleven thousand stored. Those are staffing
 * agencies and survey-spam boards. Re-processing them every rotation is what
 * kept a 10-minute turn to nineteen boards.
 *
 * Demotion here is a longer cadence, never a deletion or a blacklist: a demoted
 * board returns on its own and is re-judged. Nothing is permanently dropped,
 * and a board with thin evidence is never demoted at all.
 */

/** Postings a board must have produced before its yield means anything. */
export const ATS_YIELD_MIN_EVIDENCE = 150;

/** How long a demoted board waits before its next sweep. */
export const ATS_LOW_YIELD_CADENCE_DAYS = 28;

const ATS_VENDOR_SUBDOMAINS = new Set([
  'www', 'support', 'docs', 'help', 'blog', 'api', 'app', 'status',
  'careers', 'career', 'jobs', 'developers', 'developer', 'partners', 'resources',
]);

export type BoardYield = {
  storedJobs: number;
  survivingJobs: number;
};

export type BoardYieldVerdict = {
  classification: 'productive' | 'low_yield' | 'insufficient_evidence';
  reason: string;
};

/**
 * The board slug inside a job's URL.
 *
 * Jobs record `source` and `sourceId` but not which board produced them, and
 * the sweep is the only place that knows. The URL is the one durable link, so
 * this reproduces the same slug the board loop used.
 */
export function boardSlugFromJobUrl(
  url: string | null | undefined,
  platform: string,
): string | null {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // `mailto:` and friends parse successfully and would hand back a slug built
  // from the path, attributing one board's jobs to another.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const subdomainSlug = (baseHost: string): string | null => {
    const suffix = `.${baseHost}`;
    if (!host.endsWith(suffix)) return null;
    const slug = host.slice(0, -suffix.length);
    return slug && !slug.includes('.') && !ATS_VENDOR_SUBDOMAINS.has(slug) ? slug : null;
  };

  switch (platform) {
    case 'greenhouse': {
      // job-boards.greenhouse.io/{slug}/jobs/{id} and boards.greenhouse.io/{slug}/...
      if (!/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) return null;
      return parts[0] || null;
    }
    case 'lever':
      // jobs.lever.co/{slug}/{id}
      if (!/^jobs(?:\.[a-z]{2})?\.lever\.co$/.test(host)) return null;
      return parts[0] ? decodeURIComponent(parts[0]) : null;
    case 'ashby':
      if (host !== 'jobs.ashbyhq.com') return null;
      return parts[0] ? decodeURIComponent(parts[0]) : null;
    case 'breezy':
      return subdomainSlug('breezy.hr');
    case 'pinpoint':
      return subdomainSlug('pinpointhq.com');
    case 'rippling': {
      if (host !== 'ats.rippling.com') return null;
      const slug = parts[0] || null;
      return slug && !['api', 'jobs', 'assets', '_next'].includes(slug.toLowerCase()) ? slug : null;
    }
    case 'workable':
      // apply.workable.com/{slug}/j/{id}
      return host === 'apply.workable.com' ? parts[0] || null : null;
    case 'smartrecruiters':
      // jobs.smartrecruiters.com/{slug}/{id}
      return ['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'].includes(host)
        ? parts[0] || null
        : null;
    case 'recruitee':
      return subdomainSlug('recruitee.com');
    case 'teamtailor':
      return subdomainSlug('teamtailor.com');
    case 'personio':
      return subdomainSlug('jobs.personio.de') || subdomainSlug('jobs.personio.com');
    case 'bamboohr':
      // {slug}.bamboohr.com/careers/{id}
      return subdomainSlug('bamboohr.com');
    case 'workday': {
      // {tenant}.{shard}.myworkdayjobs.com/{locale}/{site}/job/...
      const suffix = '.myworkdayjobs.com';
      if (!host.endsWith(suffix)) return null;
      const tenant = host.slice(0, -suffix.length);
      const siteIndex = parts.findIndex((part) => part.toLowerCase() === 'job');
      const site = siteIndex > 0 ? parts[siteIndex - 1] : null;
      return tenant && site ? `${tenant}::${site}` : null;
    }
    default:
      return null;
  }
}

/**
 * A board earns demotion only by proving, over a real sample, that nothing it
 * publishes survives triage. "Surviving" means a job that is not dismissed,
 * archived, or expired — the only outcome that makes the sweep worth its cost.
 */
export function classifyBoardYield(
  input: BoardYield,
  minimumEvidence = ATS_YIELD_MIN_EVIDENCE,
): BoardYieldVerdict {
  if (input.survivingJobs > 0) {
    return {
      classification: 'productive',
      reason: `${input.survivingJobs} job(s) from this board survived triage`,
    };
  }
  if (input.storedJobs < minimumEvidence) {
    return {
      classification: 'insufficient_evidence',
      reason: `only ${input.storedJobs} stored job(s); ${minimumEvidence} needed before judging yield`,
    };
  }
  return {
    classification: 'low_yield',
    reason: `${input.storedJobs} stored job(s) and none survived triage`,
  };
}

/** When a demoted board should next be swept. */
export function lowYieldNextCheckDate(
  now: Date = new Date(),
  cadenceDays = ATS_LOW_YIELD_CADENCE_DAYS,
): Date {
  return new Date(now.valueOf() + cadenceDays * 86_400_000);
}
