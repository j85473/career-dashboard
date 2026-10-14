import assert from 'node:assert/strict';
import test from 'node:test';
import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from '@aws-sdk/client-athena';

import {
  athenaCommonCrawlQuery,
  athenaCrawlPartition,
  athenaDiscoveryConfig,
  AthenaCommonCrawlReader,
} from '../athenaCommonCrawl';

const config = { region: 'us-east-1', workGroup: 'discovery', database: 'ccindex', table: 'ccindex' };

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

test('Athena sends the persisted request token to AWS on every submission retry', async () => {
  const tokens: Array<string | undefined> = [];
  const client = { send: async (command: StartQueryExecutionCommand) => {
    assert.ok(command instanceof StartQueryExecutionCommand);
    tokens.push(command.input.ClientRequestToken);
    return { QueryExecutionId: 'same-execution' };
  } } as unknown as AthenaClient;
  const reader = new AthenaCommonCrawlReader(config, client);
  const token = 'persisted-token-0000000000000000000000';
  assert.equal(await reader.start('CC-MAIN-2026-39-index', 'job-boards.greenhouse.io/*', token), 'same-execution');
  assert.equal(await reader.start('CC-MAIN-2026-39-index', 'job-boards.greenhouse.io/*', token), 'same-execution');
  assert.deepEqual(tokens, [token, token]);
});

test('Athena skips only the initial heading and forwards result pagination tokens', async () => {
  const tokens: Array<string | undefined> = [];
  const client = { send: async (command: GetQueryResultsCommand) => {
    assert.ok(command instanceof GetQueryResultsCommand);
    tokens.push(command.input.NextToken);
    return command.input.NextToken
      ? { ResultSet: { Rows: [{ Data: [{ VarCharValue: 'https://example.com/second' }] }] } }
      : { ResultSet: { Rows: [
        { Data: [{ VarCharValue: 'url' }] }, { Data: [{ VarCharValue: 'https://example.com/first' }] },
      ] }, NextToken: 'next-page' };
  } } as unknown as AthenaClient;
  const reader = new AthenaCommonCrawlReader(config, client);
  assert.deepEqual(await reader.results('execution', null), { urls: ['https://example.com/first'], nextToken: 'next-page' });
  assert.deepEqual(await reader.results('execution', 'next-page'), { urls: ['https://example.com/second'], nextToken: null });
  assert.deepEqual(tokens, [undefined, 'next-page']);
});

test('only metadata-confirmed managed results older than 24 hours count as expired', async () => {
  for (const managed of [true, false]) for (const ageHours of [23, 25]) {
    const client = { send: async (command: GetQueryExecutionCommand) => {
      assert.ok(command instanceof GetQueryExecutionCommand);
      return { QueryExecution: {
        Status: { State: 'SUCCEEDED', CompletionDateTime: new Date(Date.now() - ageHours * 60 * 60 * 1000) },
        ManagedQueryResultsConfiguration: { Enabled: managed },
      } };
    } } as unknown as AthenaClient;
    const status = await new AthenaCommonCrawlReader(config, client).state('execution');
    assert.equal(status.resultsExpired, managed && ageHours > 24);
  }
});
