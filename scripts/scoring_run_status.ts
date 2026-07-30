import fs from 'node:fs';
import path from 'node:path';
import { parseNativeScoringManifest } from '../src/lib/nativeScoringBatch';

const projectRoot = process.cwd();
const lockPath = path.join(projectRoot, '.agents', 'scoring-lock.json');

function main(): void {
  if (!fs.existsSync(lockPath)) {
    throw new Error('No active scoring lock was found');
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    batchId?: unknown;
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
  const runRoot = path.resolve(projectRoot, lock.runRoot);
  const manifest = parseNativeScoringManifest(
    JSON.parse(fs.readFileSync(path.resolve(projectRoot, lock.manifestFile), 'utf8')),
  );
  const completed: string[] = [];
  const missing: string[] = [];
  for (const chunk of manifest.chunks) {
    const resultPath = path.resolve(runRoot, chunk.resultFile);
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
    console.log('\nAll manifest-declared result files exist. Run npm run scoring:validate.');
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(`Scoring status failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
