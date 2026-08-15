-- Key cooldowns lived only in process memory, so every restart re-tried every
-- exhausted key to rediscover it was exhausted — spending a real request per
-- key each time. Persisting them means a 12-day quota window is learned once.
CREATE TABLE "ApiKeyCooldown" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "readyAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApiKeyCooldown_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiKeyCooldown_service_keyHash_key" ON "ApiKeyCooldown"("service", "keyHash");
CREATE INDEX "ApiKeyCooldown_service_readyAt_idx" ON "ApiKeyCooldown"("service", "readyAt");
