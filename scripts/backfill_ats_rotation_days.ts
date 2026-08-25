import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assignedRotationDay,
  ATS_ROTATION_DAY_NAMES,
  ATS_ROTATION_DAYS,
  summarizeRotationBalance,
} from '../src/lib/atsRotation';
import { prisma } from '../src/lib/prisma';

const BATCH_SIZE = 2_000;

/**
 * Assigns every ATS board its rotation weekday.
 *
 * Dry-run by default. This is the only place the catalog's day assignment is
 * written, and `assignedRotationDay` is the only definition of it, so a board
 * always returns to the same cohort — re-running this cannot reshuffle the
 * week.
 *
 * It changes no schedule beyond the day a board is swept on: no board is
 * retired, no lifecycle is touched, and `nextCheckDate` is left exactly as it
 * is so nothing is pulled forward or pushed back by this pass.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const apply = argv.includes('--apply');
  if (argv.some((arg) => arg !== '--apply')) {
    throw new Error('Usage: backfill_ats_rotation_days.ts [--apply]');
  }

  const boards = await prisma.atsCompany.findMany({
    select: { slug: true, platform: true, status: true, checkDay: true },
  });

  const changes: Array<{ slug: string; platform: string; from: number; to: number }> = [];
  const activeByDay: Record<number, number> = {};
  for (const board of boards) {
    const target = assignedRotationDay(board.slug, board.platform);
    if (board.status === 'active') activeByDay[target] = (activeByDay[target] || 0) + 1;
    if (board.checkDay !== target) {
      changes.push({ slug: board.slug, platform: board.platform, from: board.checkDay, to: target });
    }
  }

  const balance = summarizeRotationBalance(activeByDay);
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    rotationDays: ATS_ROTATION_DAYS,
    boards: boards.length,
    reassignments: changes.length,
    activeCohorts: balance.cohorts.map((cohort) => ({
      day: cohort.dayName,
      boards: cohort.boards,
    })),
    activeMeanPerDay: Math.round(balance.mean),
    maxCohortDeviation: `${(balance.maxDeviation * 100).toFixed(2)}%`,
    effect: 'Sets only the sweep weekday. nextCheckDate, status, and every '
      + 'lifecycle field are left untouched.',
    writesPerformed: 0,
  }, null, 2));

  if (!apply || changes.length === 0) return;

  let written = 0;
  for (let index = 0; index < changes.length; index += BATCH_SIZE) {
    const batch = changes.slice(index, index + BATCH_SIZE);
    // Grouped by target day so each batch is a handful of updateMany calls
    // rather than one round trip per board.
    for (let day = 0; day < ATS_ROTATION_DAYS; day += 1) {
      const forDay = batch.filter((change) => change.to === day);
      if (forDay.length === 0) continue;
      const result = await prisma.atsCompany.updateMany({
        where: { OR: forDay.map(({ slug, platform }) => ({ slug, platform })) },
        data: { checkDay: day },
      });
      written += result.count;
    }
    console.log(`  assigned ${Math.min(index + BATCH_SIZE, changes.length)}/${changes.length}`);
  }

  console.log(JSON.stringify({
    mode: 'apply',
    reassigned: written,
    cohorts: ATS_ROTATION_DAY_NAMES.map((dayName, day) => ({
      day: dayName,
      boards: activeByDay[day] || 0,
    })),
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`ATS rotation day assignment failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
