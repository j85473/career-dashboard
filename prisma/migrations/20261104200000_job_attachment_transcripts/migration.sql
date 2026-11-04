ALTER TABLE "JobAttachment" DROP CONSTRAINT "JobAttachment_kind_check";
ALTER TABLE "JobAttachment" ADD CONSTRAINT "JobAttachment_kind_check"
    CHECK ("kind" IS NULL OR "kind" IN ('jd', 'prep', 'transcript'));
