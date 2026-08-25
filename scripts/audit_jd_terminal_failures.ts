import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  classifyTerminalJdFailure,
  summarizeTerminalJdFailures,
  JD_TERMINAL_DISPOSITIONS,
} from '../src/lib/jdTerminalDisposition';
import { currentAimSuppressedJobIds } from '../src/lib/currentAimFailureSuppression';
import { operationalQueueWhere } from '../src/lib/operationalQueue';
import { prisma } from '../src/lib/prisma';

/**
 * Read-only. Reports how the terminal JD failures sitting in Action Needed
 * split into operational outcomes so the disposition policy can be decided
 * from real counts. It writes nothing and changes no job.
 */
export async function main(): Promise<void> {
  const suppressed = await currentAimSuppressedJobIds(prisma);
  const jobs = await prisma.job.findMany({
    where: operationalQueueWhere('action_needed', suppressed),
    select: {
      id: true,
      company: true,
      title: true,
      scoringStatus: true,
      scoreError: true,
      passReason: true,
      description: true,
      updatedAt: true,
    },
  });

  const terminal = jobs.filter((job) => classifyTerminalJdFailure(job) !== null);
  const summary = summarizeTerminalJdFailures(terminal);
  const oldest = [...terminal].sort((left, right) => left.updatedAt.valueOf() - right.updatedAt.valueOf())[0];

  console.log(JSON.stringify({
    mode: 'read-only',
    generatedAt: new Date().toISOString(),
    actionNeededJobs: jobs.length,
    terminalJdFailures: terminal.length,
    dispositions: JD_TERMINAL_DISPOSITIONS.map((disposition) => ({
      disposition,
      ...summary[disposition],
    })),
    oldestTerminalJdFailure: oldest
      ? { id: oldest.id, company: oldest.company, updatedAt: oldest.updatedAt.toISOString() }
      : null,
    note: 'Classification only. No disposition rule is applied; expiring or dismissing any bucket requires explicit approval.',
    writesPerformed: 0,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`JD terminal failure audit failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
