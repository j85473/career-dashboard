-- Chunk-level progress published by the local watcher so the deployed dashboard,
-- which has no access to the runner's manifest directory, can display it.
ALTER TABLE "NativeScoringRequest" ADD COLUMN "chunksTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NativeScoringRequest" ADD COLUMN "chunksDone" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NativeScoringRequest" ADD COLUMN "quarantineRetries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NativeScoringRequest" ADD COLUMN "quarantineChunks" INTEGER NOT NULL DEFAULT 0;
