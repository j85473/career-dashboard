import type { Prisma } from './prismaClient';
import { normalizeUrl } from './jobIngestion';

/** Search saved links, including the original source after an Apply URL changes. */
export function jobUrlSearchWhere(query: string): Prisma.JobWhereInput {
  const trimmed = query.trim();
  // Ingestion stores canonical links with sorted parameters and no tracking.
  // Keep the original too, because observations retain the source's spelling.
  const variants = [...new Set([trimmed, normalizeUrl(trimmed)])];
  return {
    OR: variants.flatMap((variant) => {
      // Prisma's contains uses LIKE: URL escapes and underscores are literals.
      const contains = variant.replace(/[\\%_]/g, '\\$&');
      const match = { contains, mode: 'insensitive' as const };
      return [
        { url: match },
        { canonicalUrl: match },
        { observations: { some: { url: match } } },
      ];
    }),
  };
}
