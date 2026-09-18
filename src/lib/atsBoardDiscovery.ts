import type { Prisma } from '@prisma/client';

import { boardSlugFromJobUrl } from './atsBoardYield';
import { assignedRotationDay } from './atsRotation';

export type DiscoveredAtsBoard = {
  slug: string;
  platform: string;
};

type AtsCompanyClient = Pick<Prisma.TransactionClient, 'atsCompany' | '$executeRaw'>;

export type DiscoveredAtsBoardOutcome =
  | 'created'
  | 'existing'
  | 'reactivated'
  | 'retired';

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

/**
 * Duplicate tombstones were created while consolidating capitalization-only
 * copies. They point at a surviving row and are not a retirement verdict on
 * that survivor. Every other excluded row is permanent until Joseph manually
 * changes it.
 */
export function isPermanentAtsBoardRetirement(
  board: { status: string; excludedReason?: string | null },
): boolean {
  if (board.status !== 'excluded') return false;
  return !/^same board as .+ with different capitals/i.test(board.excludedReason?.trim() || '');
}

/**
 * Record a board learned from a pasted job URL or a discovery audit without
 * allowing exact or capitalization-only matches to bypass permanent
 * retirement. Call this inside a transaction whenever it is part of a larger
 * mutation.
 */
export async function recordDiscoveredAtsBoard(
  client: AtsCompanyClient,
  board: DiscoveredAtsBoard,
  now: Date = new Date(),
  options: {
    status?: 'active' | 'parked';
    jobsFound?: number;
    reactivateExisting?: boolean;
  } = {},
): Promise<DiscoveredAtsBoardOutcome> {
  // All active discovery call sites invoke this inside a transaction. The
  // database lock closes the gap between the case-insensitive read and create,
  // so two simultaneous spellings cannot both sneak in.
  // JSON keeps the two identity parts unambiguous while escaping control
  // characters. PostgreSQL text values cannot contain NUL, so the in-memory
  // separator used by some local maps is not safe to send to hashtextextended.
  const lockIdentity = JSON.stringify([
    board.platform,
    board.slug.toLocaleLowerCase('en-US'),
  ]);
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`;

  const matches = await client.atsCompany.findMany({
    where: {
      platform: board.platform,
      slug: { equals: board.slug, mode: 'insensitive' },
    },
    select: { slug: true, platform: true, status: true, excludedReason: true },
  });

  if (matches.some(isPermanentAtsBoardRetirement)) return 'retired';

  const exact = matches.find((match) => match.slug === board.slug);
  const existing = exact && exact.status !== 'excluded'
    ? exact
    : matches.find((match) => match.status !== 'excluded');

  if (existing) {
    if (options.reactivateExisting === false) return 'existing';
    const wasActive = existing.status === 'active';
    await client.atsCompany.update({
      where: { slug_platform: { slug: existing.slug, platform: existing.platform } },
      data: { status: 'active', nextCheckDate: now },
    });
    return wasActive ? 'existing' : 'reactivated';
  }

  // An orphaned capitalization-duplicate tombstone has no surviving row to
  // target. It remains excluded rather than being replaced by a new spelling.
  if (matches.length > 0) return 'retired';

  const status = options.status || 'active';
  await client.atsCompany.create({
    data: {
      slug: board.slug,
      platform: board.platform,
      checkDay: assignedRotationDay(board.slug, board.platform),
      status,
      nextCheckDate: now,
      failCount: status === 'parked' ? 1 : 0,
      jobsFound: options.jobsFound ?? (status === 'active' ? 1 : 0),
    },
  });
  return 'created';
}
