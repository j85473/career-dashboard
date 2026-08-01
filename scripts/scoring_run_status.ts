import fs from 'node:fs';
import path from 'node:path';
import { parseNativeScoringManifest } from '../src/lib/nativeScoringBatch';

const projectRoot = process.cwd();
const lockPath = path.join(projectRoot, '.agents', 'scoring-lock.json');
const runsRoot = path.join(projectRoot, '.agents', 'eval_runs');

function safeChildPath(parent: string, candidate: string, label: string): string {
  const absolute = path.resolve(parent, candidate);
  const relative = path.relative(parent, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${path.relative(projectRoot, parent)}`);
  }
  return absolute;
}

function safeRunPath(runRoot: string, candidate: string): string {
  const absolute = path.resolve(runRoot, candidate);
  const relative = path.relative(runRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe run-relative path: ${candidate}`);
  }
  return absolute;
}

function main(): void {
  if (!fs.existsSync(lockPath)) {
    throw new Error('No active scoring lock was found');
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    batchId?: unknown;
    phase?: unknown;
    runRoot?: unknown;
    manifestFile?: unknown;
  };
  if (
    typeof lock.batchId !== 'string'
    || typeof lock.runRoot !== 'string'
    || typeof lock.manifestFile !== 'string'
  ) {
    throw new Error('The active scoring lock is malformed');
  }
  const runRoot = safeChildPath(runsRoot, path.relative(runsRoot, path.resolve(projectRoot, lock.runRoot)), 'Run root');
  const manifestPath = path.resolve(projectRoot, lock.manifestFile);
  if (manifestPath !== path.join(runRoot, 'manifest.json')) {
    throw new Error('The active scoring manifest must be the selected run manifest');
  }
  const manifest = parseNativeScoringManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  if (manifest.batchId !== lock.batchId) throw new Error('Lock and manifest batch IDs differ');
  const completed: string[] = [];
  const missing: string[] = [];
  for (const chunk of manifest.chunks) {
    const resultPath = safeRunPath(runRoot, chunk.resultFile);
    if (fs.existsSync(resultPath)) {
      completed.push(chunk.chunkId);
    } else {
      missing.push(chunk.chunkId);
    }
  }

  console.log(`Batch: ${manifest.batchId}`);
  console.log(`Completed: ${completed.length}/${manifest.chunks.length}`);
  console.log(`Missing: ${missing.length}`);
  if (missing.length > 0) {
    console.log('\nSuggested bounded waves:');
    for (let index = 0; index < missing.length; index += 20) {
      console.log(missing.slice(index, index + 20).join(', '));
    }
  } else {
    console.log(
      `\nAll manifest-declared result files exist. Run npm run scoring:${
        lock.phase === 'context' ? 'context:validate' : 'validate'
      }.`,
    );
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(`Scoring status failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
