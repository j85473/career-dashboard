import assert from 'node:assert/strict';
import test from 'node:test';

import { isAtsBoardLevelFailure, isAtsProviderWideError, parseAtsListingPayload } from '../atsAcquisition';
import { AtsProviderFailureRecordedError, fetchAtsPlatformResponse, platformPauseRemainingMs, RateLimitedError } from '../jobIngestion';

const board = { platform: 'oracle', slug: 'acme.fa.us2.oraclecloud.com::CX' };
const requestedUrl = 'https://acme.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
const healthyBoard = { ...board, slug: 'acme.fa.us2.oraclecloud.com::Healthy' };
const validPayload = { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '123', Title: 'Partner Manager' }] }] };
const fixtures = [
  { name: 'missing title', body: JSON.stringify({ items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '123' }] }] }), message: /no title/ },
  { name: 'missing posting identity', body: JSON.stringify({ items: [{ TotalJobsCount: 1, requisitionList: [{ Title: 'Partner Manager' }] }] }), message: /no valid posting identity/ },
  { name: 'invalid search envelope', body: JSON.stringify({ items: [] }), message: /one search envelope/ },
  { name: 'invalid JSON', body: '<html>Tenant unavailable</html>', message: /Unexpected token/ },
];

for (const fixture of fixtures) {
  test(`Oracle ${fixture.name} fails that board while queued healthy requests continue`, async () => {
    const failures: string[] = [];
    const starts: string[] = [];
    let validationError: unknown;
    const scheduling = {
      requestedUrl,
      waitForSlot: async () => {},
      withCrossProcessLease: (action: () => Promise<Response>) => action(),
      recordFailure: async ({ provider }: { provider: string }) => { failures.push(provider); return null; },
    };
    const badListing = fetchAtsPlatformResponse('oracle', undefined, async () => {
      starts.push('bad listing');
      return new Response(fixture.body, { headers: { 'content-type': 'application/json' } });
    }, {
      ...scheduling,
      onResponse: async (response) => {
        try {
          parseAtsListingPayload('oracle', await response.json(), null, board);
        } catch (error) {
          validationError = error;
          throw error;
        }
      },
    });
    // Attach the rejection handler before starting successors in the same
    // Oracle request bucket; a failed validator must release its turn.
    const rejected = assert.rejects(badListing, (error: unknown) => {
      assert.equal(error, validationError, 'the board error must not be wrapped as a recorded provider failure');
      assert.match((error as Error).message, fixture.message);
      assert.equal(isAtsBoardLevelFailure(error), true, 'retain the board retry policy');
      assert.equal(isAtsProviderWideError(error, 'oracle'), false, 'the dispatcher must also keep the error on its board');
      return true;
    });
    const healthyListing = fetchAtsPlatformResponse('oracle', undefined, async () => {
      starts.push('healthy listing');
      return Response.json(validPayload);
    }, {
      ...scheduling,
      onResponse: async (response) => {
        assert.equal(parseAtsListingPayload('oracle', await response.json(), null, healthyBoard).jobs[0].id, `${healthyBoard.slug}::123`);
      },
    });
    const healthyDetail = fetchAtsPlatformResponse('oracle', undefined, async () => {
      starts.push('healthy detail');
      return Response.json({ Id: '123', ExternalDescriptionStr: 'Full description' });
    }, { ...scheduling, recordPlatformFailures: false });
    await Promise.all([rejected, healthyListing, healthyDetail]);
    assert.deepEqual(starts, ['bad listing', 'healthy listing', 'healthy detail']);
    assert.deepEqual(failures, [], 'neither response validation nor listing classification may open the shared circuit');
    assert.equal(platformPauseRemainingMs('oracle'), 0);
  });
}

test('other ATS schema failures retain their shared circuit behavior', async () => {
  const error = new Error('greenhouse listing schema expected a jobs array');
  const failures: string[] = [];
  await assert.rejects(fetchAtsPlatformResponse('greenhouse', undefined, async () => Response.json({}), {
    waitForSlot: async () => {},
    withCrossProcessLease: (action) => action(),
    recordFailure: async ({ provider }) => { failures.push(provider); return null; },
    onResponse: async () => { throw error; },
  }), (recorded: unknown) => recorded instanceof AtsProviderFailureRecordedError && recorded.providerError === error);
  assert.deepEqual(failures, ['ATS-greenhouse']);
  assert.equal(isAtsProviderWideError(error, 'greenhouse'), true);
  assert.equal(isAtsProviderWideError(new Error('Workday listing schema is invalid'), 'workday'), true);
});

test('an Oracle detail 429 still publishes a shared cooldown before a validation error escapes', async () => {
  const throttles: string[] = [];
  const error = new RateLimitedError('oracle');
  await assert.rejects(fetchAtsPlatformResponse('oracle', undefined, async () => (
    new Response('', { status: 429, headers: { 'retry-after': '120' } })
  ), {
    requestedUrl,
    waitForSlot: async () => {},
    withCrossProcessLease: (action) => action(),
    recordPlatformFailures: false,
    recordThrottle: async (platform) => { throttles.push(platform); },
    onResponse: async () => { throw error; },
  }), (rejected: unknown) => rejected === error);
  assert.deepEqual(throttles, ['oracle']);
  assert.ok(platformPauseRemainingMs('oracle') > 110_000);
  assert.equal(isAtsProviderWideError(error, 'oracle'), true);
  assert.equal(isAtsBoardLevelFailure(error), false);
});
