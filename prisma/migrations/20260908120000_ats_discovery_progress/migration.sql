-- Durable home for Common Crawl slug-discovery progress, previously a JSON file
-- in whichever working directory happened to run the crawler.
--
-- Keyed by URL pattern rather than platform: Greenhouse serves tenants from two
-- hosts, and a per-platform key would let the old host's "fully crawled" marker
-- declare the newly added host done without ever requesting it.
CREATE TABLE "AtsDiscoveryProgress" (
    "platform" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "indexId" TEXT NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "completedThrough" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtsDiscoveryProgress_pkey" PRIMARY KEY ("platform", "pattern")
);
