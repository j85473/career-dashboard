/**
 * Scheduled entry point for Common Crawl ATS board discovery.
 *
 * Common Crawl publishes roughly one index a month, and the crawler skips any
 * platform that is already complete through the newest one, so a weekly run is
 * cheap: most weeks every platform is skipped in a single collinfo.json fetch,
 * and the week after a new index lands it walks only that index.
 *
 *   node --import tsx scripts/cron/run_discovery.ts
 */
import { runCronMain, runDiscoveryAndWait } from './http';

runCronMain(runDiscoveryAndWait);
