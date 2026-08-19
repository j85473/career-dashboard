import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * The Dice actor is on an Apify-side schedule (03:10 daily). `client.actor(...)
 * .call(...)` STARTS a run and bills for it, so an ingestion path that used it
 * made the scraper run — and charge — twice every day: once on the schedule and
 * once when this code fired near midnight.
 *
 * Ingestion pulls results in; it does not commission them. These are
 * source-text assertions because the failure is a billing one: it costs money
 * silently and produces plausible-looking data, so nothing downstream detects it.
 */
const SCHEDULED_ACTOR_CONSUMERS = [
  'src/app/api/pipeline/dice/route.ts',
  'scripts/cron/dice_apify.ts',
];

for (const file of SCHEDULED_ACTOR_CONSUMERS) {
  test(`${file} reads the last run instead of starting one`, () => {
    const source = readFileSync(file, 'utf8');

    assert.ok(
      !/\.actor\([^)]*\)\s*\.call\(/s.test(source),
      `${file} calls .call() on an Apify actor, which starts a paid run. `
      + 'Read the last succeeded run instead: client.actor(ACTOR).lastRun({ status: "SUCCEEDED" }).get()',
    );

    assert.match(
      source,
      /\.lastRun\(\s*\{\s*status:\s*'SUCCEEDED'\s*\}\s*\)/,
      `${file} should read the last SUCCEEDED run's dataset`,
    );

    // Without the staleness check, a stopped Apify schedule looks like a
    // healthy ingestion run that happens to re-import the same listings.
    assert.match(source, /MAX_DATASET_AGE_HOURS/, `${file} should guard against a stale dataset`);
  });
}
