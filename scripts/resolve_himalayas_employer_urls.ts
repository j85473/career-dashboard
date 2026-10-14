import 'dotenv/config';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { discoverEmployerBoards, type EmployerBoardDiscovery } from '../src/lib/employerAtsDiscovery';
import { getHimalayasCompanyDetails } from '../src/lib/himalayasMcp';
import { HIMALAYAS_REPAIR_STATUSES, applyHimalayasLinkRepair, himalayasCompanySlug,
  selectHimalayasEmployerPosting, type HimalayasRepairJob } from '../src/lib/himalayasEmployerResolution';
import { isPermanentAtsBoardRetirement, recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';
import { rotatingCandidateIds } from '../src/lib/himalayasBrowserResolver';

function options(argv: string[]) {
  let apply = false;
  let limit = 8;
  let companySlug: string | undefined;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice(8));
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('--limit must be between 1 and 25');
    } else if (arg.startsWith('--company-slug=')) {
      companySlug = arg.slice(15).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,120}$/.test(companySlug)) throw new Error('Invalid --company-slug');
    } else throw new Error('Usage: resolve_himalayas_employer_urls.ts [--apply] [--limit=N] [--company-slug=SLUG]');
  }
  return { apply, limit, companySlug };
}

async function persistDiscovery(employerKey: string, companyName: string, website: string, discovery: EmployerBoardDiscovery) {
  return prisma.$transaction(async tx => {
    const outcome = await recordDiscoveredAtsBoard(tx, discovery.board, new Date(), {
      jobsFound: discovery.postings.length, reactivateExisting: false,
    });
    if (outcome === 'retired') return false;
    const board = await tx.atsCompany.findFirst({
      where: { platform: discovery.board.platform, slug: { equals: discovery.board.slug, mode: 'insensitive' }, status: { not: 'excluded' } },
      select: { platform: true, slug: true },
    });
    if (!board) return false;
    const data = { companyName, officialWebsite: website, evidenceUrl: discovery.evidenceUrl,
      discoverySource: 'himalayas_mcp_official_site', verifiedAt: new Date() };
    await tx.employerAtsBoard.upsert({
      where: { employerKey_slug_platform: { employerKey, ...board } },
      create: { employerKey, ...board, ...data }, update: data,
    });
    return true;
  });
}

async function main() {
  const { apply, limit, companySlug } = options(process.argv.slice(2));
  const rows = await prisma.job.findMany({
    where: { source: { equals: 'Himalayas', mode: 'insensitive' }, status: { in: HIMALAYAS_REPAIR_STATUSES } },
    select: { id: true, title: true, company: true, location: true, description: true,
      url: true, canonicalUrl: true, source: true, status: true, updatedAt: true },
    orderBy: { id: 'asc' },
  });
  const groups = new Map<string, HimalayasRepairJob[]>();
  for (const job of rows) {
    const slug = himalayasCompanySlug(job.canonicalUrl || job.url);
    if (!slug || (companySlug && slug !== companySlug)) continue;
    const group = groups.get(slug) || [];
    group.push(job);
    groups.set(slug, group);
  }
  const cursorPath = process.env.EMPLOYER_RESOLVER_CURSOR_PATH
    || '/var/lib/career-dashboard/data/runtime/employer-resolver-cursor.json';
  let cursor = 0;
  try {
    const parsed = JSON.parse(await readFile(cursorPath, 'utf8'));
    if (Number.isInteger(parsed.nextOffset) && parsed.nextOffset >= 0) cursor = parsed.nextOffset;
  } catch { /* first run */ }
  const rotation = rotatingCandidateIds([...groups.keys()].sort(), companySlug ? 0 : cursor, limit);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — checking ${rotation.ids.length} of ${groups.size} unresolved Himalayas employers; link repairs only`);
  let matched = 0;
  let repaired = 0;
  for (const slug of rotation.ids) {
    try {
      const group = groups.get(slug)!;
      const employerKey = `himalayas:${slug}`;
      // Cache the MCP website, never a frozen job catalogue. Re-crawl the
      // official careers pages and all supported linked feeds on each pass.
      const cached = await prisma.employerAtsBoard.findFirst({
        where: { employerKey, verifiedAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
        orderBy: { verifiedAt: 'desc' }, select: { officialWebsite: true },
      });
      const website = cached?.officialWebsite || (await getHimalayasCompanyDetails(slug))?.website;
      if (!website) { console.log(`  ${slug}: official website unavailable; deferred`); continue; }
      const discoveries = await discoverEmployerBoards({ website, jobs: group });
      const allPostings = discoveries.flatMap(item => item.postings);
      const usable: EmployerBoardDiscovery[] = [];
      for (const discovery of discoveries) {
        const registered = await prisma.atsCompany.findMany({
          where: { platform: discovery.board.platform, slug: { equals: discovery.board.slug, mode: 'insensitive' } },
          select: { status: true, excludedReason: true },
        });
        if (registered.some(isPermanentAtsBoardRetirement)) continue;
        if (!apply || discovery.matchCount === 0
          || await persistDiscovery(employerKey, group[0].company, website, discovery)) usable.push(discovery);
      }
      const postings = usable.flatMap(item => item.postings);
      for (const job of group) {
        const match = selectHimalayasEmployerPosting(job, allPostings);
        if (!match || !postings.some(posting => posting.url === match.url)) continue;
        matched += 1;
        console.log(`  ${slug}: ${job.id} -> ${match.url}`);
        if (apply && await applyHimalayasLinkRepair(job, allPostings, prisma)) repaired += 1;
      }
    } catch (error) {
      // One unavailable employer cannot starve the remainder of the rotation.
      console.log(`  ${slug}: deferred (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (apply && !companySlug) {
    await writeFile(`${cursorPath}.tmp`, `${JSON.stringify({ nextOffset: rotation.nextCursor })}\n`, { mode: 0o600 });
    await rename(`${cursorPath}.tmp`, cursorPath);
  }
  console.log(`Proven matches: ${matched}; links repaired: ${repaired}. Scores, descriptions, and card decisions preserved.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
