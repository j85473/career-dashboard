import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { planAtsRotationWorkload, summarizeAtsWorkload, type AtsWorkloadBoard } from '../src/lib/atsRotationWorkload';
import { reviewAtsRotationWorkload } from '../src/lib/atsRotationBalancing';
import { prisma } from '../src/lib/prisma';

export function decodeAtsWorkloadSnapshot(rows: Record<string, unknown>[]): AtsWorkloadBoard[] {
  const date = (value: unknown) => value == null || value === '' ? null : new Date(String(value));
  return rows.map((row) => ({
    slug: String(row.slug), platform: String(row.platform), checkDay: Number(row.checkDay),
    jobsFound: Number(row.jobsFound), failCount: Number(row.failCount), retryCount: Number(row.retryCount),
    nextCheckDate: date(row.nextCheckDate)!, lastProcessedAt: date(row.lastProcessedAt),
    rotationMovedAt: date(row.rotationMovedAt), sampleAt: date(row.sampleAt),
    sampleJobs: row.sampleJobs == null || row.sampleJobs === '' ? null : Number(row.sampleJobs),
    workerMs: row.workerMs == null || row.workerMs === '' ? null : Number(row.workerMs),
    hasOpenWork: row.hasOpenWork === true || row.hasOpenWork === 't',
  }));
}

export async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const snapshotIndex = argv.indexOf('--snapshot');
  const nowIndex = argv.indexOf('--now');
  const allowed = new Set(['--apply', '--snapshot', '--now']);
  for (let i = 0; i < argv.length; i += 1) {
    if (!allowed.has(argv[i])) throw new Error('Usage: balance_ats_rotation.ts [--apply] [--snapshot file.json] [--now ISO-date]');
    if (argv[i] !== '--apply' && !argv[++i]) throw new Error('Missing option value');
  }
  if (apply && (snapshotIndex >= 0 || nowIndex >= 0)) throw new Error('Apply requires a fresh database snapshot and the actual current time.');
  const now = nowIndex >= 0 ? new Date(argv[nowIndex + 1]) : new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error('Invalid observation time');
  const report = snapshotIndex >= 0
    ? { mode: 'preview', ...planAtsRotationWorkload(decodeAtsWorkloadSnapshot(JSON.parse(readFileSync(argv[snapshotIndex + 1], 'utf8'))), now),
      appliedMoves: [], writesPerformed: 0 }
    : await reviewAtsRotationWorkload(prisma, apply, now);
  console.log(JSON.stringify({ ...report, beforeSummary: summarizeAtsWorkload(report.before),
    afterSummary: summarizeAtsWorkload(report.after) }, null, 2));
  return report;
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
