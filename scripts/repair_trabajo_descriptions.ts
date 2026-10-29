import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { cleanJobDescriptionPage, looksLikeTrabajoPageChrome } from '../src/lib/jobDescriptionCleanup';
import { derivePostingFacts } from '../src/lib/postingFacts';

// Dry run by default. Changes only descriptions and their literal display
// facts. Never rescores, requeues, changes lifecycle, or edits score artifacts.
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: repair_trabajo_descriptions.ts [--apply]');
  const apply = args.includes('--apply');
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Job"
    WHERE description LIKE ${'%trabajo.org%'}
      AND description LIKE ${'%This job listing is provided by a partner site%'}
    ORDER BY id
  `;
  const jobs = await prisma.job.findMany({ where: { id: { in: ids.map(row => row.id) } } });
  const repairs = jobs.flatMap(job => {
    const description = cleanJobDescriptionPage(job.description || '');
    if (!description || description === job.description || looksLikeTrabajoPageChrome(description)) return [];
    return [{ before: job, description }];
  });
  console.log(JSON.stringify({ apply, candidates: jobs.length, repairable: repairs.length,
    unchanged: jobs.length - repairs.length,
    repairs: repairs.map(({ before, description }) => ({ id: before.id, title: before.title,
      status: before.status, before: before.description?.length, after: description.length })) }, null, 2));
  if (!apply || repairs.length === 0) return;
  const directory = path.resolve('data/runtime', `trabajo-description-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Full original rows, including the raw reader responses, are durable before
  // the first mutation. Exact-text predicates protect intervening edits.
  await writeFile(path.join(directory, 'before.json'), JSON.stringify(repairs, null, 2), { mode: 0o600, flag: 'wx' });
  let repaired = 0;
  for (const { before, description } of repairs) {
    const result = await prisma.job.updateMany({
      where: { id: before.id, description: before.description, updatedAt: before.updatedAt },
      data: { description, ...derivePostingFacts(description) },
    });
    repaired += result.count;
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ repaired, skipped: repairs.length - repaired }), { mode: 0o600 });
  console.log(JSON.stringify({ repaired, skipped: repairs.length - repaired, backup: directory }));
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
