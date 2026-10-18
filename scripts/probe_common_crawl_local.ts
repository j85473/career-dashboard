import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PLATFORMS, patternsFor } from '../src/scripts/discoverATS';
import { downloadLocalCrawlDirectory, localCrawlBlockFile, localCrawlPlanHash, localCrawlPatternMatches,
  planLocalCrawl, readLocalCrawlBlock, removeLocalCrawlFile } from '../src/lib/localCommonCrawl';

/** Database-free sizing/transport proof. Never admits boards or earns receipts. */
async function main() {
  const args = process.argv.slice(2);
  const arg = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const indexId = arg('--index') || 'CC-MAIN-2026-39-index';
  const workspace = path.resolve(arg('--workspace') || '/tmp/career-cc-probe');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const patterns = Object.entries(PLATFORMS).flatMap(([platform, value]) => patternsFor(value).map(pattern => ({ platform, pattern })));
  const directory = arg('--directory') || await downloadLocalCrawlDirectory(workspace, indexId);
  const plan = await planLocalCrawl(directory, indexId, patterns);
  const hash = localCrawlPlanHash(plan);
  const sampleCount = args.includes('--all-blocks') ? plan.blocks.length : Math.min(3, plan.blocks.length);
  const progressFile = path.join(workspace, `${indexId}.probe-progress.json`);
  const samples: Array<{ ordinal: number; records: number; matchingRecords: number; compressedBytes: number; elapsedMs: number }> = [];
  if (args.includes('--resume')) {
    if (!args.includes('--all-blocks')) throw new Error('--resume requires --all-blocks.');
    const saved = JSON.parse(await readFile(progressFile, 'utf8'));
    if (saved.planHash !== hash || !Array.isArray(saved.samples)
      || saved.samples.some((sample: { ordinal: number }, i: number) => sample.ordinal !== i)
      || saved.samples.length > plan.blocks.length) throw new Error('Probe progress belongs to a different plan.');
    samples.push(...saved.samples);
  }
  // Spread the default sample over the selected URL space.
  for (let i = samples.length; i < sampleCount; i++) {
    const ordinal = args.includes('--all-blocks') ? i : Math.floor(i * (plan.blocks.length - 1) / Math.max(1, sampleCount - 1));
    const start = Date.now();
    const records = await readLocalCrawlBlock(plan, ordinal, workspace);
    const matching = records.filter(r => plan.blocks[ordinal].patterns.some(p => localCrawlPatternMatches(patterns[p].pattern, r.url)));
    samples.push({ ordinal, records: records.length, matchingRecords: matching.length, compressedBytes: plan.blocks[ordinal].length, elapsedMs: Date.now() - start });
    await writeFile(progressFile, JSON.stringify({ planHash: hash, samples }, null, 2) + '\n', { mode: 0o600 });
    await removeLocalCrawlFile(localCrawlBlockFile(workspace, hash, ordinal));
    if (i + 1 < sampleCount) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const report = { measuredAt: new Date().toISOString(), indexId, directoryBytes: plan.directoryBytes,
    manifestSha256: plan.manifestSha256, patternCount: patterns.length, blockCount: plan.blocks.length,
    compressedBytes: plan.compressedBytes, maxBlockBytes: Math.max(0, ...plan.blocks.map(b => b.length)),
    patterns, samples };
  const destination = arg('--report') || path.join(workspace, `${indexId}.measurement.json`);
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  // Re-read the saved artifact so its reported size is the deliverable's size.
  const reportBytes = (await readFile(destination)).length;
  console.log(JSON.stringify({ ...report, patterns: undefined, report: destination, reportBytes }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
