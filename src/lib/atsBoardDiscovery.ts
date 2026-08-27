import type { Prisma } from '@prisma/client';

import { boardSlugFromJobUrl } from './atsBoardYield';
import { assignedRotationDay } from './atsRotation';

export type DiscoveredAtsBoard = {
  slug: string;
  platform: string;
};

/**
 * Human-facing ATS labels that map to a public, schedulable board adapter.
 * Vendors without a complete unauthenticated board feed are intentionally
 * absent: recording one would create an endpoint the acquisition loop cannot
 * actually run.
 */
export const DISCOVERABLE_ATS_PLATFORM_BY_LABEL: Readonly<Record<string, string>> = {
  Ashby: 'ashby',
  BambooHR: 'bamboohr',
  Breezy: 'breezy',
  Greenhouse: 'greenhouse',
  Lever: 'lever',
  Personio: 'personio',
  Pinpoint: 'pinpoint',
  Recruitee: 'recruitee',
  Rippling: 'rippling',
  SmartRecruiters: 'smartrecruiters',
  Teamtailor: 'teamtailor',
  Workable: 'workable',
  Workday: 'workday',
};

/**
 * Derive a schedulable board identity without fetching or changing the job.
 *
 * Workday's CXS tenant omits the infrastructure shard (`adobe`), while the
 * public board hostname and AtsCompany identity must retain it (`adobe.wd5`).
 * The shared URL parser also rejects vanity and vendor hosts that cannot
 * authoritatively identify one of the supported public board adapters.
 */
export function discoveredAtsBoardFromJobUrl(
  url: string,
  detectedAts: string,
): DiscoveredAtsBoard | null {
  const platform = DISCOVERABLE_ATS_PLATFORM_BY_LABEL[detectedAts];
  if (!platform) return null;
  const slug = boardSlugFromJobUrl(url, platform);
  return slug ? { slug, platform } : null;
}

/** Build the same activation write for link-only and full-scrape discovery. */
export function discoveredAtsBoardUpsert(
  board: DiscoveredAtsBoard,
  now: Date = new Date(),
): Prisma.AtsCompanyUpsertArgs {
  return {
    where: {
      slug_platform: { slug: board.slug, platform: board.platform },
    },
    update: {
      status: 'active',
      nextCheckDate: now,
    },
    create: {
      slug: board.slug,
      platform: board.platform,
      checkDay: assignedRotationDay(board.slug, board.platform),
      status: 'active',
      nextCheckDate: now,
      failCount: 0,
      jobsFound: 1,
    },
  };
}
