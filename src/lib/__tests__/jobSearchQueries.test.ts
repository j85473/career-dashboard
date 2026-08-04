import assert from 'node:assert/strict';
import test from 'node:test';
import { PRIMARY_JOB_SEARCH_QUERIES } from '../jobSearchQueries';

test('production ingestion uses only the precise target-role search set', () => {
  assert.deepEqual(PRIMARY_JOB_SEARCH_QUERIES, [
    'channel account manager',
    'channel partner manager',
    'partner account manager',
    'distribution sales manager',
    'territory sales manager',
    'strategic territory manager',
    'regional sales manager',
    'field sales manager',
    'key account manager',
    'national account manager',
    'strategic account manager',
    'customer sales manager',
  ]);
});
