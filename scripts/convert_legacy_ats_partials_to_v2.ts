import {
  assertLegacyAtsConversionAuthority,
  convertLegacyAtsBatchToV2,
  inspectLegacyAtsConversionCandidates,
} from '../src/lib/atsLegacyConversion';
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

function valuesAfter(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function integerAfter(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] || '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} requires a positive integer.`);
  return parsed;
}

async function main(): Promise<void> {
  await assertLegacyAtsConversionAuthority();
  const batchIds = valuesAfter('--batch-id');
  const limit = integerAfter('--limit', 10_000);
  const candidates = await inspectLegacyAtsConversionCandidates({
    batchIds: batchIds.length > 0 ? batchIds : undefined,
    limit,
  });
  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      total: candidates.length,
      convertible: candidates.filter((candidate) => candidate.convertible).length,
      invalid: candidates.filter((candidate) => !candidate.convertible).length,
      candidates,
    }));
    return;
  }

  const results = [];
  for (const candidate of candidates) {
    if (!candidate.convertible) {
      results.push({ ...candidate, outcome: 'invalid' as const });
      continue;
    }
    const result = await convertLegacyAtsBatchToV2(candidate.batchId);
    results.push(result);
    console.error(JSON.stringify({
      batchId: result.batchId,
      platform: result.platform,
      slug: result.slug,
      outcome: result.outcome,
      reason: result.reason,
    }));
  }
  const summary = {
    apply: true,
    total: results.length,
    converted: results.filter((result) => result.outcome === 'converted').length,
    alreadyV2: results.filter((result) => result.outcome === 'already_v2').length,
    busy: results.filter((result) => result.outcome === 'busy').length,
    invalid: results.filter((result) => result.outcome === 'invalid').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
    results,
  };
  console.log(JSON.stringify(summary));
  if (summary.failed > 0 || summary.busy > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
