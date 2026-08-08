-- The pipeline lock moves from a host-local file into the shared database.
-- A filesystem lock cannot exclude the other host, so the Mac and the Pi could
-- each start a pipeline against the same data.
ALTER TABLE "PipelineState" ADD COLUMN "lockToken" TEXT;
ALTER TABLE "PipelineState" ADD COLUMN "lockOwner" TEXT;
ALTER TABLE "PipelineState" ADD COLUMN "lockHeartbeatAt" TIMESTAMP(3);
