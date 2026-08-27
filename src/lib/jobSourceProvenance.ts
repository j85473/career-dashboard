import { urlMatchesAnyHost } from './urlHost';

type SourceObservation = {
  source?: string | null;
  url?: string | null;
};

type PreferredJdSourceInput = {
  source?: string | null;
  jobUrl?: string | null;
  observations?: readonly SourceObservation[] | null;
};

const CAREERFORCE_SOURCE = 'careerforce';
const DEJOBS_SYNDICATION_SOURCES = new Set([CAREERFORCE_SOURCE, 'dejobs']);
const DEJOBS_SOURCE_HOSTS = ['dejobs.org', 'jobsyn.org'] as const;

export function isCareerForceSource(source: string | null | undefined): boolean {
  return source?.trim().toLowerCase() === CAREERFORCE_SOURCE;
}

export function isDejobsSyndicationSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && DEJOBS_SYNDICATION_SOURCES.has(source.trim().toLowerCase());
}

/**
 * A DEjobs or CareerForce source listing contains the DEjobs posting GUID
 * needed to read its static per-posting JSON. The user-facing Job URL
 * intentionally points at the employer's application page, so recovery must
 * prefer the raw source observation without replacing that Apply destination.
 */
export function preferredJdSourceUrl(input: PreferredJdSourceInput): string | null {
  if (!isDejobsSyndicationSource(input.source)) return input.jobUrl || null;

  const originalDejobsUrl = input.observations?.find((observation) => (
    isDejobsSyndicationSource(observation.source)
    && urlMatchesAnyHost(observation.url, DEJOBS_SOURCE_HOSTS)
  ))?.url;

  return originalDejobsUrl || input.jobUrl || null;
}
