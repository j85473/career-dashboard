import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import {
  generateV4Fingerprint,
  himalayasCompanySlug,
  isHimalayasJunkCompanyName,
} from '../src/lib/jobIngestion';

/**
 * Repairs only Himalayas rows whose company is the literal string "name".
 *
 * Himalayas briefly returned that placeholder in `companyName`, while the
 * posting URL continued to identify the real company. Existing rows cannot
 * self-heal because stable source observations intentionally stop duplicate
 * ingestion before canonical fields are rewritten.
 *
 * A repair is accepted only when the current Himalayas search API returns
 * either the exact stored posting or one current posting under the exact same
 * provider-owned company slug, with one unambiguous non-junk company name. If
 * an old company has no searchable postings left, the provider-owned slug is
 * retained as a lowercase identifier, just like the ingestion fallback. No
 * title-only match or invented brand casing is written. Dry run by default;
 * pass --apply to write the verified plan in one guarded transaction.
 */

const prisma = new PrismaClient();
const CONCURRENCY = 3;

type Candidate = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  sourceId: string | null;
};

type Repair = Candidate & {
  replacement: string;
  verification: 'exact_posting' | 'company_slug' | 'provider_slug';
};

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') {
      throw new Error('Usage: repair_himalayas_company_names.ts [--apply]');
    }
  }
  return { apply: argv.includes('--apply') };
}

function normalizedPostingIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value.trim();
  }
}

async function searchHimalayas(query: string, candidateId: string): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    q: query,
    country: 'US',
    sort: 'recent',
    page: '1',
  });
  const response = await fetch(`https://himalayas.app/jobs/api/search?${params.toString()}`);
  if (!response.ok) throw new Error(`Himalayas HTTP ${response.status} for job ${candidateId}`);

  const payload = await response.json() as { jobs?: unknown };
  return Array.isArray(payload.jobs)
    ? payload.jobs.filter((job): job is Record<string, unknown> => Boolean(job && typeof job === 'object'))
    : [];
}

function companyForSlug(jobs: Record<string, unknown>[], slug: string): string | null {
  const names = new Map<string, string>();
  for (const job of jobs) {
    if (himalayasCompanySlug(job.applicationLink) !== slug) continue;
    if (isHimalayasJunkCompanyName(job.companyName)) continue;
    const name = String(job.companyName).trim();
    names.set(name.toLowerCase(), name);
  }
  return names.size === 1 ? [...names.values()][0] : null;
}

async function resolveCandidate(candidate: Candidate): Promise<Repair | null> {
  const storedSlug = himalayasCompanySlug(candidate.url) || himalayasCompanySlug(candidate.sourceId);
  if (!storedSlug) return null;

  const jobs = await searchHimalayas(candidate.title, candidate.id);
  const identifiers = new Set(
    [candidate.url, candidate.sourceId]
      .map(normalizedPostingIdentifier)
      .filter((value): value is string => Boolean(value)),
  );

  for (const job of jobs) {
    const returnedIdentifiers = [job.guid, job.applicationLink]
      .map(normalizedPostingIdentifier)
      .filter((identifier): identifier is string => Boolean(identifier));
    if (!returnedIdentifiers.some((identifier) => identifiers.has(identifier))) continue;
    if (isHimalayasJunkCompanyName(job.companyName)) return null;
    if (himalayasCompanySlug(job.applicationLink) !== storedSlug) return null;
    return {
      ...candidate,
      replacement: String(job.companyName).trim(),
      verification: 'exact_posting',
    };
  }

  const sameSlugFromTitleSearch = companyForSlug(jobs, storedSlug);
  if (sameSlugFromTitleSearch) {
    return { ...candidate, replacement: sameSlugFromTitleSearch, verification: 'company_slug' };
  }

  const companyJobs = await searchHimalayas(storedSlug.replace(/[-_]+/g, ' '), candidate.id);
  const replacement = companyForSlug(companyJobs, storedSlug);
  return replacement
    ? { ...candidate, replacement, verification: 'company_slug' }
    : {
        ...candidate,
        replacement: storedSlug.replace(/[-_]+/g, ' '),
        verification: 'provider_slug',
      };
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));
  const candidates = await prisma.job.findMany({
    where: {
      source: 'Himalayas',
      company: { equals: 'name', mode: 'insensitive' },
    },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      url: true,
      sourceId: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const repairs: Repair[] = [];
  const unresolved: Candidate[] = [];
  for (let index = 0; index < candidates.length; index += CONCURRENCY) {
    const batch = candidates.slice(index, index + CONCURRENCY);
    const results = await Promise.all(batch.map(resolveCandidate));
    results.forEach((repair, offset) => {
      if (repair) repairs.push(repair);
      else unresolved.push(batch[offset]);
    });
  }

  const verificationCounts = repairs.reduce((counts, repair) => {
    counts[repair.verification] += 1;
    return counts;
  }, { exact_posting: 0, company_slug: 0, provider_slug: 0 });
  console.log(`Examined ${candidates.length} Himalayas row(s) with company = "name".`);
  console.log(`  ${repairs.length} safe repair(s) planned.`);
  console.log(`    ${verificationCounts.exact_posting} verified by exact current posting.`);
  console.log(`    ${verificationCounts.company_slug} verified by a current posting under the same company slug.`);
  console.log(`    ${verificationCounts.provider_slug} use the provider-owned slug fallback.`);
  console.log(`  ${unresolved.length} unresolved posting(s) will remain unchanged.`);
  for (const repair of repairs) {
    console.log(`  ${repair.id}: "name" -> "${repair.replacement}" [${repair.verification}] (${repair.title})`);
  }
  for (const candidate of unresolved) {
    console.log(`  UNRESOLVED ${candidate.id}: ${candidate.title}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write only the verified replacements above.');
    return;
  }

  const updates = await prisma.$transaction(
    repairs.map((repair) => prisma.job.updateMany({
      where: {
        id: repair.id,
        source: 'Himalayas',
        company: repair.company,
        url: repair.url,
        sourceId: repair.sourceId,
      },
      data: {
        company: repair.replacement,
        identityFingerprint: generateV4Fingerprint(
          repair.title,
          repair.replacement,
          repair.location || 'Unknown Location',
        ),
      },
    })),
  );
  const updated = updates.reduce((sum, result) => sum + result.count, 0);
  if (updated !== repairs.length) {
    throw new Error(`Guarded repair changed ${updated} row(s), expected ${repairs.length}`);
  }
  console.log(`\nApplied ${updated} verified company-name repair(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
