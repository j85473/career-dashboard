-- Release A is expand-only. Distributed execution and drain admission remain
-- dormant until a compatible binary explicitly activates the durable gate.
ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD COLUMN "admissionState" TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN "drainRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cutoverReadyAt" TIMESTAMP(3),
  ADD COLUMN "distributedAuthorityActivatedAt" TIMESTAMP(3),
  ADD COLUMN "distributedWriterVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "remoteWorkersEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "globalSlotLimit" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "localSlotReserve" INTEGER NOT NULL DEFAULT 4;

ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_admission_state_check"
    CHECK ("admissionState" IN ('open', 'draining')),
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_distributed_writer_check"
    CHECK ("distributedWriterVersion" >= 0),
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_slot_limit_check"
    CHECK (
      "localSlotReserve" = 4
      AND "globalSlotLimit" BETWEEN "localSlotReserve" AND 8
    );

CREATE TABLE "AtsAcquisitionWorkerSlot" (
  "slotNumber" INTEGER NOT NULL,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseFence" BIGINT NOT NULL DEFAULT 0,
  "workerKind" TEXT,
  "releaseId" TEXT,
  "acquiredAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsAcquisitionWorkerSlot_pkey" PRIMARY KEY ("slotNumber"),
  CONSTRAINT "AtsAcquisitionWorkerSlot_number_check" CHECK ("slotNumber" BETWEEN 1 AND 8),
  CONSTRAINT "AtsAcquisitionWorkerSlot_lease_shape_check" CHECK (
    ("leaseToken" IS NULL AND "leaseOwner" IS NULL AND "workerKind" IS NULL AND "releaseId" IS NULL
      AND "acquiredAt" IS NULL AND "heartbeatAt" IS NULL AND "leaseExpiresAt" IS NULL)
    OR
    ("leaseToken" IS NOT NULL AND "leaseOwner" IS NOT NULL AND "workerKind" IS NOT NULL AND "releaseId" IS NOT NULL
      AND "acquiredAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AtsAcquisitionWorkerSlot_leaseToken_key"
  ON "AtsAcquisitionWorkerSlot"("leaseToken");
CREATE INDEX "AtsAcquisitionWorkerSlot_leaseExpiresAt_idx"
  ON "AtsAcquisitionWorkerSlot"("leaseExpiresAt");
CREATE INDEX "AtsAcquisitionWorkerSlot_workerKind_heartbeatAt_idx"
  ON "AtsAcquisitionWorkerSlot"("workerKind", "heartbeatAt");

CREATE TABLE "AtsAcquisitionCutoverReceipt" (
  "id" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "localDay" DATE NOT NULL,
  "dailyTarget" INTEGER NOT NULL,
  "confirmedContacts" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "lastLegacyAttemptId" TEXT,
  "lastV2WorkReceiptId" TEXT,
  "lastV2SegmentId" TEXT,
  "exceptionCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsAcquisitionCutoverReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AtsAcquisitionCutoverReceipt_counts_check" CHECK (
    "dailyTarget" >= 0 AND "confirmedContacts" >= 0 AND "exceptionCount" >= 0
  )
);

CREATE UNIQUE INDEX "AtsAcquisitionCutoverReceipt_snapshotHash_key"
  ON "AtsAcquisitionCutoverReceipt"("snapshotHash");
CREATE INDEX "AtsAcquisitionCutoverReceipt_verifiedAt_idx"
  ON "AtsAcquisitionCutoverReceipt"("verifiedAt");
CREATE INDEX "AtsAcquisitionCutoverReceipt_localDay_idx"
  ON "AtsAcquisitionCutoverReceipt"("localDay");

CREATE FUNCTION "reject_ats_cutover_receipt_change"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ATS cutover receipts are immutable evidence.';
END;
$$;

CREATE TRIGGER "guard_ats_cutover_receipt_immutable"
BEFORE UPDATE OR DELETE ON "AtsAcquisitionCutoverReceipt"
FOR EACH ROW EXECUTE FUNCTION "reject_ats_cutover_receipt_change"();
