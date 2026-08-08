import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads chunk progress out of a runner batch directory.
 *
 * Only the machine running the Antigravity runner has these files; the deployed
 * dashboard reads the numbers back from the database instead. Kept free of
 * Prisma imports so the watcher can use it without opening a second client.
 */

export const NATIVE_SCORING_EVAL_ROOT = '.agents/eval_runs';

const BATCH_ID_PATTERN = /^native_[0-9a-f-]{36}_(context|standard)_[0-9a-f]{8}$/i;

export interface NativeScoringBatchProgress {
  chunksTotal: number;
  chunksDone: number;
  quarantineRetries: number;
  quarantineChunks: number;
}

export const EMPTY_BATCH_PROGRESS: NativeScoringBatchProgress = {
  chunksTotal: 0,
  chunksDone: 0,
  quarantineRetries: 0,
  quarantineChunks: 0,
};

function countJsonFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Returns zeroed progress rather than throwing: this feeds a status panel, and a
 * batch directory that is missing, half-written, or being rewritten mid-wave
 * must never take down the request status it is displayed beside.
 */
export function summarizeBatchDirectory(
  batchId: string | null | undefined,
  root: string = NATIVE_SCORING_EVAL_ROOT,
): NativeScoringBatchProgress {
  if (!batchId || !BATCH_ID_PATTERN.test(batchId)) return EMPTY_BATCH_PROGRESS;

  const resolvedRoot = path.resolve(root);
  const batchDirectory = path.resolve(resolvedRoot, batchId);
  // The id is already pattern-checked; this also refuses anything that escapes
  // the root through symlinks or an unexpected root value.
  if (batchDirectory !== path.join(resolvedRoot, batchId)) return EMPTY_BATCH_PROGRESS;

  const chunks = countJsonFiles(path.join(batchDirectory, 'chunks'));
  if (chunks.length === 0) return EMPTY_BATCH_PROGRESS;

  const results = countJsonFiles(path.join(batchDirectory, 'results'));
  const quarantine = countJsonFiles(path.join(batchDirectory, 'quarantine'));
  // A chunk can be quarantined more than once, so files count retries while
  // distinct chunk ids count how many chunks are actually troubled.
  const quarantinedChunkIds = new Set(quarantine.map((name) => name.split('.')[0]));

  return {
    chunksTotal: chunks.length,
    chunksDone: Math.min(results.length, chunks.length),
    quarantineRetries: quarantine.length,
    quarantineChunks: quarantinedChunkIds.size,
  };
}

/** Picks the batch the request is currently working through. */
export function currentBatchId(request: {
  phase: string;
  contextBatchId: string | null;
  standardBatchId: string | null;
}): string | null {
  return request.phase.startsWith('context')
    ? request.contextBatchId || request.standardBatchId
    : request.standardBatchId || request.contextBatchId;
}
