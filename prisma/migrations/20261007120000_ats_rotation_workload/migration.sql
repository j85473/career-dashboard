ALTER TABLE "AtsCompany" ADD COLUMN "rotationMovedAt" TIMESTAMP(3);

CREATE TABLE "AtsRotationBalanceState" (
  "id" TEXT NOT NULL,
  "days" JSONB NOT NULL,
  "profiles" JSONB NOT NULL,
  "refreshedAt" TIMESTAMP(3) NOT NULL,
  "lastRebalancedAt" TIMESTAMP(3),
  CONSTRAINT "AtsRotationBalanceState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AtsRotationBalanceRun" (
  "id" TEXT NOT NULL,
  "report" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtsRotationBalanceRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AtsRotationBalanceRun_createdAt_idx" ON "AtsRotationBalanceRun"("createdAt");
