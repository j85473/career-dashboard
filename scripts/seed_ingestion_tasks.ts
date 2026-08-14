import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import {
  completionBasedNextRunAt,
  evaluateProviderAvailability,
  reconcileIngestionTaskCatalog,
} from '../src/lib/ingestionControl';
import {
  canonicalIngestionTaskDefinitions,
  configuredIngestionTaskCatalogOptions,
} from '../src/lib/ingestionTaskCatalog';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [mode] = process.argv.slice(2);
  if (!['--dry-run', '--apply'].includes(mode || '') || process.argv.length !== 3) {
    throw new Error('Usage: seed_ingestion_tasks.ts --dry-run | --apply');
  }
  const apply = mode === '--apply';

  const atsRows = await prisma.atsCompany.findMany({
    select: { platform: true },
    distinct: ['platform'],
    orderBy: { platform: 'asc' },
  });
  const options = configuredIngestionTaskCatalogOptions(
    process.env,
    atsRows.map((row) => row.platform),
  );
  const definitions = canonicalIngestionTaskDefinitions(options);
  const specs = definitions.map((definition) => definition.spec);

  const [schema] = await prisma.$queryRaw<Array<{ ingestionTask: boolean }>>`
    SELECT to_regclass('"IngestionTask"') IS NOT NULL AS "ingestionTask";
  `;
  if (!schema?.ingestionTask) {
    throw new Error('IngestionTask is missing; apply the expand migration before seeding task definitions.');
  }

  const catalog = apply
    ? await prisma.$transaction(
        (tx) => reconcileIngestionTaskCatalog(specs, { apply: true, client: tx }),
        { maxWait: 5_000, timeout: 60_000 },
      )
    : await reconcileIngestionTaskCatalog(specs, { client: prisma });
  const now = new Date();
  const blockedRows = await prisma.ingestionTask.findMany({
    where: {
      taskKind: 'search',
      lifecycleStatus: 'active',
      status: { in: ['blocked_circuit', 'blocked_budget'] },
      leaseToken: null,
    },
    select: { id: true, taskKey: true, source: true, status: true, nextRunAt: true },
  });
  const circuits = await prisma.providerCircuit.findMany({
    where: { provider: { in: [...new Set(blockedRows.map((row) => row.source))] } },
  });
  const circuitByProvider = new Map(circuits.map((circuit) => [circuit.provider, circuit]));
  const blockedRebases = blockedRows.flatMap((task) => {
    const circuit = circuitByProvider.get(task.source);
    if (!circuit) return [];
    const availability = evaluateProviderAvailability({ ...circuit, now });
    if (availability.allowed || !availability.retryAt) return [];
    const status = availability.reason === 'circuit_open' ? 'blocked_circuit' : 'blocked_budget';
    const nextRunAt = completionBasedNextRunAt({
      taskKey: task.taskKey,
      status,
      finishedAt: now,
      cadenceMs: 0,
      providerRetryAt: availability.retryAt,
    });
    if (nextRunAt.getTime() === task.nextRunAt.getTime() && task.status === status) return [];
    return [{
      id: task.id,
      taskKey: task.taskKey,
      status,
      reason: availability.reason,
      before: task.nextRunAt.toISOString(),
      after: nextRunAt.toISOString(),
      nextRunAt,
    }];
  });
  if (apply) {
    for (const rebase of blockedRebases) {
      const updated = await prisma.ingestionTask.updateMany({
        where: { id: rebase.id, leaseToken: null, status: { in: ['blocked_circuit', 'blocked_budget'] } },
        data: { status: rebase.status, nextRunAt: rebase.nextRunAt },
      });
      if (updated.count !== 1) throw new Error(`Refusing raced blocked-task rebase: ${rebase.taskKey}`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    catalogHash: catalog.catalogHash,
    configuredOptionalSources: {
      careerOneStop: options.includeCareerOneStop || false,
      adzuna: options.includeAdzuna || false,
      usaJobs: options.includeUsaJobs || false,
    },
    atsPlatforms: options.atsPlatforms || [],
    catalog,
    blockedRebases: blockedRebases.map((rebase) => ({
      taskKey: rebase.taskKey,
      status: rebase.status,
      reason: rebase.reason,
      before: rebase.before,
      after: rebase.after,
    })),
    before: {
      total: catalog.unchanged.length + catalog.reactivations.length + catalog.retirements.length + catalog.orchestration.length,
      activeExpected: catalog.expectedTaskCount - catalog.additions.length,
    },
    after: {
      activeExpected: catalog.expectedTaskCount,
      retiredByThisRun: catalog.retirements.length,
      orchestration: catalog.orchestration.length,
      blockedRebased: blockedRebases.length,
    },
    providerRequests: 0,
    leasesClaimed: 0,
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
