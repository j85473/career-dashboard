-- Release B moves all ATS acquisition to the Mac worker. The Pi keeps paid
-- searches and Careerforce and continues to host PostgreSQL on the SSD, but it
-- no longer reserves ATS acquisition lanes for itself.
--
-- Release A pinned "localSlotReserve" = 4 because a Mac worker was only ever
-- admitted alongside four live Pi lanes. Release B keeps every other bound --
-- the reserve stays non-negative and the global limit stays between the
-- reserve and 8 -- and only stops requiring the reserve to be exactly four.
-- No column is removed and no row is rewritten, so recorded acquisition work,
-- receipts, and scores keep the authority they already have.
ALTER TABLE "AtsAcquisitionRuntimeGate"
  DROP CONSTRAINT "AtsAcquisitionRuntimeGate_slot_limit_check";

ALTER TABLE "AtsAcquisitionRuntimeGate"
  ADD CONSTRAINT "AtsAcquisitionRuntimeGate_slot_limit_check"
    CHECK (
      "localSlotReserve" >= 0
      AND "globalSlotLimit" BETWEEN "localSlotReserve" AND 8
      AND "globalSlotLimit" >= 1
    );
