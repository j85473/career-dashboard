import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { getAllResumes } from '../src/lib/resume';
import { passesPreFilter } from '../src/lib/jobFiltering';
import { looksLikeInvalidJobDescription, runLocalHeuristic } from '../src/lib/jobScoring';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes('--apply');
const cutoff = new Date(Date.now() - 21 * 24 * 60 * 60 * 1_000);

async function jobIsLive(url: string | null): Promise<boolean> {
  if (!url) return true;
  try {
    const response = await safeExternalFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 || response.status === 410) return false;
    const text = await response.text();
    return !/\b(?:job is no longer available|position has been filled|job not found|job has expired)\b/i.test(text);
  } catch {
    // A blocked validator is not proof that a job is closed.
    return true;
  }
}

async function main() {
  const [resumes, preferences] = await Promise.all([
    getAllResumes(),
    prisma.userPreference.findMany(),
  ]);
  if (resumes.length === 0) throw new Error('No bound resume is available for local recovery.');

  let cursor: string | undefined;
  let reviewed = 0;
  let eligible = 0;
  let needsJd = 0;
  let closed = 0;

  while (true) {
    const jobs = await prisma.job.findMany({
      where: {
        createdAt: { gte: cutoff },
        status: { in: ['dismissed', 'archived'] },
        scoringStatus: 'skipped',
        OR: [
          { passReason: { startsWith: '[Local', mode: 'insensitive' } },
          { passReason: { contains: 'location rejected', mode: 'insensitive' } },
          { passReason: { contains: 'remote role restricted', mode: 'insensitive' } },
        ],
      },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (jobs.length === 0) break;
    cursor = jobs.at(-1)?.id;

    for (const job of jobs) {
      reviewed++;
      if (!(await jobIsLive(job.canonicalUrl || job.url))) {
        closed++;
        if (apply) await prisma.job.update({ where: { id: job.id }, data: { status: 'expired' } });
        continue;
      }
      const description = job.description || '';
      if (description.length < 400 || looksLikeInvalidJobDescription(description)) {
        needsJd++;
        if (apply) {
          await prisma.job.update({
            where: { id: job.id },
            data: { status: 'pending_af', scoringStatus: 'needs_jd', passReason: 'Recovery: job description needs refresh.' },
          });
        }
        continue;
      }
      const filter = passesPreFilter({
        title: job.title,
        company: job.company,
        description,
        location: job.location || '',
        url: job.url || '',
      });
      if (!filter.passes) continue;
      const local = runLocalHeuristic({
        title: job.title,
        company: job.company,
        url: job.url,
        source: job.source,
        manualAts: job.manualAts,
        fullDescription: description,
      }, resumes, preferences);
      if (!local.gatePass) continue;
      eligible++;
      if (apply) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'pending_af',
            scoringStatus: 'queued',
            fitScore: local.score,
            fitCategory: local.category,
            fitRationale: local.rationale,
            recommendedResume: local.recommendedResume,
            aimFitScore: null,
            reqFitScore: null,
            reqFitRationale: null,
            travelScore: null,
            experienceStatus: 'queued',
            afBatchId: null,
            batchJobId: null,
            passReason: 'Recovery: newly eligible under the V6.6 commercial-growth local gate.',
          },
        });
      }
    }
    console.log(`Reviewed ${reviewed}; eligible ${eligible}; needs JD ${needsJd}; closed ${closed}.`);
    if (!apply) break;
  }

  console.log(`${apply ? 'Applied' : 'Dry run'}: ${eligible} job(s) eligible for local/A/E recovery, ${needsJd} need JD recovery, ${closed} closed.`);
  if (!apply) console.log('Re-run with --apply to process all 21-day candidates in batches of 500.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
