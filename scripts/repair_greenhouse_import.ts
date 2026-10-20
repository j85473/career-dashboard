import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { scrapeAtsApi } from '../src/lib/atsApi';
import { planGreenhouseImportRepair } from '../src/lib/greenhouseImportRepair';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';

/** Explicit single-card repair only. Preserve every score, decision, history and lease. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = args.find(arg => arg.startsWith('--job-id='))?.slice('--job-id='.length);
  const receiptDir = args.find(arg => arg.startsWith('--receipt-dir='))?.slice('--receipt-dir='.length);
  const apply = args.includes('--apply');
  if (!id || !/^[a-f0-9-]{36}$/.test(id) || !receiptDir || args.some(arg =>
    arg !== '--apply' && !arg.startsWith('--job-id=') && !arg.startsWith('--receipt-dir='))) {
    throw new Error('Usage: repair_greenhouse_import.ts --job-id=<UUID> --receipt-dir=<directory> [--apply]');
  }
  const before = await prisma.job.findUniqueOrThrow({ where: { id } });
  const recovered = before.url ? await scrapeAtsApi(before.url) : null;
  const data = planGreenhouseImportRepair(before, recovered);
  await mkdir(receiptDir, { recursive: true });
  // Save original source content before any write. Receipts are operator files,
  // never production assets or a replacement for source observation history.
  await writeFile(`${receiptDir}/${id}-before.json`, JSON.stringify(before, null, 2), { flag: 'wx' });
  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', id, title: before.title, priorCharacters: before.description?.length,
      recoveredCharacters: data.description.length, changedFields: Object.keys(data),
      metadata: { title: data.title, company: data.company, location: data.location }, statusPreserved: before.status }));
    return;
  }
  const receipt = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
    const protectedEvidence = async () => ({
      scoreEvents: await tx.jobScoreEvent.findMany({ where: { jobId: id }, orderBy: { id: 'asc' } }),
      artifacts: await tx.jobScoringArtifact.findMany({ where: { jobId: id }, orderBy: { id: 'asc' } }),
      extractions: await tx.aimFactualExtraction.findMany({ where: { jobId: id }, orderBy: { id: 'asc' } }),
      statusHistory: await tx.jobStatusHistory.findMany({ where: { jobId: id }, orderBy: { id: 'asc' } }),
      scoringStatusHistory: await tx.jobScoringStatusHistory.findMany({ where: { jobId: id }, orderBy: { id: 'asc' } }),
      observations: await tx.jobSourceObservation.findMany({ where: { jobId: id }, orderBy: { id: 'asc' } }),
      batchItems: await tx.scoringBatchItem.findMany({ where: { jobId: id }, orderBy: { id: 'asc' } }),
    });
    const evidenceBefore = await protectedEvidence();
    const active = await tx.scoringBatchItem.count({ where: { jobId: id, status: 'leased' } });
    if (active || before.batchJobId || before.afBatchId || before.jdBatchId || before.scoringStatus === 'scoring') throw new Error('Card has active scoring work; defer repair');
    const result = await tx.job.updateMany({ where: { id, updatedAt: before.updatedAt, url: before.url,
      batchJobId: null, afBatchId: null, jdBatchId: null, scoringStatus: { not: 'scoring' } }, data });
    if (result.count !== 1) throw new Error('Card changed before repair; nothing was written');
    const after = await tx.job.findUniqueOrThrow({ where: { id } });
    const protectedFields = (job: typeof before) => {
      const mutableFields = new Set([...Object.keys(data), 'updatedAt']);
      return Object.fromEntries(Object.entries(job).filter(([key]) => !mutableFields.has(key)));
    };
    assert.deepEqual(protectedFields(after), protectedFields(before));
    assert.deepEqual(await protectedEvidence(), evidenceBefore);
    await recordJobPipelineEvent({ eventType: 'metadata_repaired', jobId: id, stage: 'metadata',
      source: before.source, sourceId: before.sourceId,
      identityParts: ['explicit_greenhouse_import_repair', before.updatedAt.toISOString()],
      details: { route: 'explicit_greenhouse_import_repair', changedFields: Object.keys(data),
        priorMetadata: { title: before.title, company: before.company, location: before.location },
        metadata: { title: after.title, company: after.company, location: after.location },
        scoresPreserved: true, lifecyclePreserved: true } }, tx);
    return { id, title: after.title, changedFields: Object.keys(data), priorCharacters: before.description?.length,
      recoveredCharacters: after.description?.length, protectedFieldsUnchanged: true,
      statusPreserved: after.status, scoresAndHistoryUnchanged: true,
      scoreEventCount: evidenceBefore.scoreEvents.length,
      protectedFieldsHash: createHash('sha256').update(JSON.stringify(protectedFields(after))).digest('hex'),
      repairedAt: after.updatedAt, after };
  }, { timeout: 30_000 });
  await writeFile(`${receiptDir}/${id}-applied.json`, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  const { after: _after, ...summary } = receipt;
  console.log(JSON.stringify({ mode: 'apply', ...summary }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
