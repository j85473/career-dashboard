-- Keep the final persistence retry explanation alongside its existing schedule.
ALTER TABLE "AtsIngestionSegment" ADD COLUMN "holdReason" TEXT;
