import assert from 'node:assert/strict';
import test from 'node:test';

import { createConcurrencyLimiter } from '../ingestionConcurrency';

test('the shared ingestion limiter never exceeds its configured bound', async () => {
  const withSlot = createConcurrencyLimiter(3);
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const work = Array.from({ length: 9 }, () => withSlot(async () => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
  }));

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peak, 3);
  release();
  await Promise.all(work);
  assert.equal(active, 0);
});
