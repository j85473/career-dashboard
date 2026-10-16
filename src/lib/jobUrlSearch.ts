import type { Prisma, PrismaClient } from './prismaClient';
import { normalizeUrl } from './jobIngestion';

const SOURCE_ID_LIMIT = 10_000;

/** Search saved links, including the original source after an Apply URL changes. */
function urlMatches(query: string) {
  const trimmed = query.trim();
  // Ingestion stores canonical links with sorted parameters and no tracking.
  // Keep the original too, because observations retain the source's spelling.
  const variants = [...new Set([trimmed, normalizeUrl(trimmed)])];
  return variants.map((variant) => {
    // Prisma's contains uses LIKE: URL escapes and underscores are literals.
    const contains = variant.replace(/[\\%_]/g, '\\$&');
    return { contains, mode: 'insensitive' as const };
  });
}

/** Resolve retained links once, so the outer OR can use Job's URL/id indexes. */
export async function jobSourceUrlMatchIds(query: string, db: Pick<PrismaClient, 'jobSourceObservation'>) {
  const rows = await db.jobSourceObservation.findMany({
    where: { OR: urlMatches(query).map((match) => ({ url: match })) },
    select: { jobId: true },
    distinct: ['jobId'],
    take: SOURCE_ID_LIMIT + 1,
  });
  return rows.map((row) => row.jobId);
}

export function jobUrlSearchWhere(query: string, sourceMatchIds: string[] = []): Prisma.JobWhereInput {
  return {
    OR: [
      ...urlMatches(query).flatMap((match) => [
        { url: match },
        { canonicalUrl: match },
      ]),
      // Broad fragments can match more ids than a database statement can bind.
      // Fall back to the indexed relation predicate, keeping every match.
      ...(sourceMatchIds.length > SOURCE_ID_LIMIT
        ? [{ observations: { some: { OR: urlMatches(query).map((match) => ({ url: match })) } } }]
        : sourceMatchIds.length ? [{ id: { in: sourceMatchIds } }] : []),
    ],
  };
}
