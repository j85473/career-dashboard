import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import { recordProviderSuccess } from '../ingestionControl';
import { prisma } from '../prisma';

test('a later Oracle success preserves an active persisted 429 and its incident until expiry', async (t) => {
  const refusedAt = new Date('2026-10-07T17:00:00Z');
  const openUntil = new Date('2026-10-07T17:02:00Z');
  const circuit = { state: 'open', openUntil: openUntil as Date | null,
    lastFailureAt: refusedAt, lastError: 'oracle rate-limited this request' as string | null,
    lastSuccessAt: null as Date | null, consecutiveFailures: 1 };
  const incident = { status: 'open', resolvedAt: null as Date | null };
  let closures = 0;
  const tx = {
    providerCircuit: {
      findUnique: async () => ({ ...circuit }),
      update: async ({ data }: { data: { lastSuccessAt: Date } }) => Object.assign(circuit, data),
      upsert: async ({ update }: { update: Partial<typeof circuit> }) => {
        closures++;
        return Object.assign(circuit, update);
      },
    },
    providerIncident: {
      updateMany: async ({ data }: { data: Partial<typeof incident> }) => {
        Object.assign(incident, data);
        return { count: 1 };
      },
    },
  };
  t.mock.method(prisma, '$transaction', async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient));

  const laterSuccess = new Date('2026-10-07T17:00:02Z');
  await recordProviderSuccess('ATS-oracle', laterSuccess);
  assert.equal(circuit.state, 'open');
  assert.equal(circuit.openUntil, openUntil);
  assert.equal(circuit.lastError, 'oracle rate-limited this request');
  assert.equal(circuit.lastSuccessAt, laterSuccess);
  assert.equal(circuit.consecutiveFailures, 1);
  assert.equal(incident.status, 'open');
  assert.equal(incident.resolvedAt, null);
  assert.equal(closures, 0);

  // A later soft failure may replace the error text but cannot shorten the
  // earlier 429 protection; a subsequent success must preserve it as well.
  circuit.lastError = 'HTTP 500';
  await recordProviderSuccess('ATS-oracle', new Date('2026-10-07T17:00:03Z'));
  assert.equal(circuit.state, 'open');
  assert.equal(circuit.openUntil, openUntil);
  assert.equal(incident.status, 'open');
  assert.equal(closures, 0);

  const afterExpiry = new Date('2026-10-07T17:02:01Z');
  await recordProviderSuccess('ATS-oracle', afterExpiry);
  assert.equal(circuit.state, 'closed');
  assert.equal(circuit.openUntil, null);
  assert.equal(circuit.lastSuccessAt, afterExpiry);
  assert.equal(circuit.consecutiveFailures, 0);
  assert.equal(incident.status, 'resolved');
  assert.equal(incident.resolvedAt, afterExpiry);
  assert.equal(closures, 1);
});
