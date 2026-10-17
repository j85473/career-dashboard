import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { scrapeAtsApi } from '../src/lib/atsApi';
import { assessJobDescriptionQuality, looksLikeSiteConfiguration } from '../src/lib/jobDescriptionQuality';

/** Explicit single-card repair only. Preserve every score, decision, history and lease. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = args.find(arg => arg.startsWith('--job-id='))?.slice('--job-id='.length);
  const receiptDir = args.find(arg => arg.startsWith('--receipt-dir='))?.slice('--receipt-dir='.length);
  const apply = args.includes('--apply');
  if (!id || !/^[a-f0-9-]{36}$/.test(id) || !receiptDir || args.some(arg =>
    arg !== '--apply' && !arg.startsWith('--job-id=') && !arg.startsWith('--receipt-dir='))) {
    throw new Error('Usage: repair_eightfold_import.ts --job-id=<UUID> --receipt-dir=<directory> [--apply]');
  }
  const before = await prisma.job.findUniqueOrThrow({ where: { id } });
  if (!before.url || !looksLikeSiteConfiguration(before.description || '')) throw new Error('Card does not contain the configuration corruption this repair handles');
  const recovered = await scrapeAtsApi(before.url);
  if (!recovered || recovered.ats !== 'Eightfold'
    || !assessJobDescriptionQuality(recovered.text, { structuredSource: true }).scorable
    || recovered.title?.trim().toLowerCase() !== before.title.trim().toLowerCase()
    || recovered.company?.trim().toLowerCase() !== before.company.trim().toLowerCase()) {
    throw new Error('The exact Eightfold posting and employer could not be verified');
  }
  const data = { description: recovered.text, manualAts: 'Eightfold' };
  await mkdir(receiptDir, { recursive: true });
  // Save original source content before any write. Receipts are operator files,
  // never production assets or a replacement for source observation history.
  await writeFile(`${receiptDir}/${id}-before.json`, JSON.stringify(before, null, 2), { flag: 'wx' });
  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', id, title: before.title, priorCharacters: before.description?.length,
      recoveredCharacters: data.description.length, changedFields: Object.keys(data) }));
    return;
  }
  const receipt = await prisma.$transaction(async tx => {
    const active = await tx.scoringBatchItem.count({ where: { jobId: id, status: 'leased' } });
    if (active || before.batchJobId || before.afBatchId || before.jdBatchId || before.scoringStatus === 'scoring') throw new Error('Card has active scoring work; defer repair');
    const result = await tx.job.updateMany({ where: { id, updatedAt: before.updatedAt, url: before.url,
      batchJobId: null, afBatchId: null, jdBatchId: null, scoringStatus: { not: 'scoring' } }, data });
    if (result.count !== 1) throw new Error('Card changed before repair; nothing was written');
    const after = await tx.job.findUniqueOrThrow({ where: { id } });
    const protectedFields = (job: typeof before) => {
      const { description: _description, manualAts: _manualAts, updatedAt: _updatedAt, ...protectedValues } = job;
      return protectedValues;
    };
    assert.deepEqual(protectedFields(after), protectedFields(before));
    return { id, title: after.title, changedFields: Object.keys(data), priorCharacters: before.description?.length,
      recoveredCharacters: after.description?.length, protectedFieldsUnchanged: true,
      protectedFieldsHash: createHash('sha256').update(JSON.stringify(protectedFields(after))).digest('hex'),
      repairedAt: after.updatedAt, after };
  }, { timeout: 30_000 });
  await writeFile(`${receiptDir}/${id}-applied.json`, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  const { after: _after, ...summary } = receipt;
  console.log(JSON.stringify({ mode: 'apply', ...summary }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
