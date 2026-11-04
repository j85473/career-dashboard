ALTER TABLE "JobAttachment" ADD COLUMN "kind" TEXT;
ALTER TABLE "JobAttachment" ADD CONSTRAINT "JobAttachment_kind_check"
    CHECK ("kind" IS NULL OR "kind" IN ('jd', 'prep'));
