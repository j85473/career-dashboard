import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { createNativeScoringRequest } from '../src/lib/nativeScoringRequest';

const prisma = new PrismaClient();

function parseSource(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--source' || !/^[a-z0-9_-]{1,80}$/i.test(argv[1] || '')) {
    throw new Error('Usage: scoring:request -- --source agy');
  }
  return argv[1];
}

async function main() {
  const source = parseSource(process.argv.slice(2));
  const result = await createNativeScoringRequest(source, prisma);
  console.log(JSON.stringify({
    id: result.request.id,
    created: result.created,
    resumed: result.resumed,
    status: result.request.status,
    phase: result.request.phase,
  }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
