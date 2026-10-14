import assert from 'node:assert/strict';
import test from 'node:test';

import {
  athenaCommonCrawlQuery,
  athenaCrawlPartition,
  athenaDiscoveryConfig,
} from '../athenaCommonCrawl';

test('Athena maps a CDX index id to its URL-index partition', () => {
  assert.equal(athenaCrawlPartition('CC-MAIN-2026-39-index'), 'CC-MAIN-2026-39');
  assert.throws(() => athenaCrawlPartition('not-an-index'));
});

test('Athena discovery stays disabled until production explicitly enables it', () => {
  assert.equal(athenaDiscoveryConfig({}), null);
  assert.throws(() => athenaDiscoveryConfig({ ATS_DISCOVERY_SOURCE: 'athena' }));
});

test('Athena uses partition and host predicates for an exact board host', () => {
  const query = athenaCommonCrawlQuery('CC-MAIN-2026-39-index', 'job-boards.greenhouse.io/*', {
    database: 'ccindex', table: 'ccindex',
  });
  assert.match(query, /crawl = 'CC-MAIN-2026-39'/);
  assert.match(query, /url_host_name = 'job-boards\.greenhouse\.io'/);
  assert.doesNotMatch(query, /url_path LIKE/);
});

test('Athena constrains wildcard subdomains and configured paths', () => {
  const query = athenaCommonCrawlQuery('CC-MAIN-2026-39-index', '*.bamboohr.com/careers*', {
    database: 'ccindex', table: 'ccindex',
  });
  assert.match(query, /url_host_name LIKE '%\.bamboohr\.com'/);
  assert.match(query, /url_path LIKE '\/careers%'/);
});
