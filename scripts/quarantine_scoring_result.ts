import fs from 'node:fs';
import path from 'node:path';
import { parseNativeScoringManifest } from '../src/lib/nativeScoringBatch';

const projectRoot = process.cwd();
const lockPath = path.join(projectRoot, '.agents', 'scoring-lock.json');

function parseArguments(argv: string[]): { apply: boolean; chunkId: string } {
  let apply = false;
  let chunkId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') {
      apply = true;
    } else if (argv[index] === '--chunk') {
      chunkId = argv[index + 1] || null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!chunkId || !/^chunk_\d{4}$/.test(chunkId)) {
    throw new Error('Provide a chunk ID such as --chunk chunk_0007');
  }
  return { apply, chunkId };
}

function main(): void {
  const { apply, chunkId } = parseArguments(process.argv.slice(2));
  if (!fs.existsSync(lockPath)) {
    throw new Error('No active scoring lock was found');
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    runRoot?: unknown;
    manifestFile?: unknown;
  };
  if (typeof lock.runRoot !== 'string' || typeof lock.manifestFile !== 'string') {
    throw new Error('The active scoring lock is malformed');
  }
  const runRoot = path.resolve(projectRoot, lock.runRoot);
  const manifest = parseNativeScoringManifest(
    JSON.parse(fs.readFileSync(path.resolve(projectRoot, lock.manifestFile), 'utf8')),
  );
  const chunk = manifest.chunks.find((entry) => entry.chunkId === chunkId);
  if (!chunk) {
    throw new Error(`${chunkId} is not in the active manifest`);
  }
  const resultPath = path.resolve(runRoot, chunk.resultFile);
  if (!fs.existsSync(resultPath)) {
    throw new Error(`${chunkId} has no result file to quarantine`);
  }
  const quarantineDir = path.join(runRoot, 'quarantine');
  const quarantineName = `${chunkId}.${new Date().toISOString().replace(/[:.]/g, '-')}.invalid.json`;
  const quarantinePath = path.join(quarantineDir, quarantineName);

  console.log(`Result: ${path.relative(projectRoot, resultPath)}`);
  console.log(`Quarantine destination: ${path.relative(projectRoot, quarantinePath)}`);
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to preserve and remove this result from the completed set.');
    return;
  }

  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.renameSync(resultPath, quarantinePath);
  console.log(`${chunkId} was quarantined and can now be retried with a fresh evaluator.`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`Result quarantine failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
