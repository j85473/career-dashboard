-- PipelineState is a single mutable row, so a stall left no trace once it was
-- overwritten: past outages could not be diagnosed at all. This records the
-- transitions only — not the per-second ticker — so the trail stays small.
CREATE TABLE "PipelineStateEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "currentStep" TEXT NOT NULL,
    "stepProgress" TEXT,
    "isRunning" BOOLEAN NOT NULL,
    "schedulePaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedUntil" TIMESTAMP(3),
    "lockOwner" TEXT,
    "detail" TEXT,
    CONSTRAINT "PipelineStateEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PipelineStateEvent_occurredAt_idx" ON "PipelineStateEvent"("occurredAt");
CREATE INDEX "PipelineStateEvent_eventType_occurredAt_idx" ON "PipelineStateEvent"("eventType", "occurredAt");
