import 'dotenv/config';

import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import {
  buildIngestionTaskKey,
  seedIngestionTaskSpecs,
} from '../src/lib/ingestionControl';
import {
  canonicalIngestionTaskDefinitions,
  configuredIngestionTaskCatalogOptions,
} from '../src/lib/ingestionTaskCatalog';

const prisma = new PrismaClient();

function catalogHash(taskKeys: readonly string[]): string {
  return createHash('sha256')
    .update(`${JSON.stringify([...taskKeys].sort())}\n`)
    .digest('hex');
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error('This command accepts no arguments; it only upserts canonical task definitions.');
  }

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
  const taskKeys = [...new Set(specs.map(buildIngestionTaskKey))].sort();

  const [schema] = await prisma.$queryRaw<Array<{ ingestionTask: boolean }>>`
    SELECT to_regclass('"IngestionTask"') IS NOT NULL AS "ingestionTask";
  `;
  if (!schema?.ingestionTask) {
    throw new Error('IngestionTask is missing; apply the expand migration before seeding task definitions.');
  }

  const seeded = await seedIngestionTaskSpecs(specs, { client: prisma });
  process.stdout.write(`${JSON.stringify({
    mode: 'seed-definitions-only',
    catalogHash: catalogHash(taskKeys),
    configuredOptionalSources: {
      careerOneStop: options.includeCareerOneStop || false,
      adzuna: options.includeAdzuna || false,
      usaJobs: options.includeUsaJobs || false,
    },
    atsPlatforms: options.atsPlatforms || [],
    expectedTaskCount: taskKeys.length,
    seededTaskCount: seeded.length,
    taskKeys,
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
