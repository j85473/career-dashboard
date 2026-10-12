import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../prisma';
import { paceAtsProviderRequest } from '../ingestionControl';
import { atsRequestSpacingMs } from '../atsRequestPacing';

test('provider pacing is shared, cancellable and releases the exact fence', async t => {
  const original = { upsert: prisma.providerCircuit.upsert, findUnique: prisma.providerCircuit.findUnique,
    updateMany: prisma.providerCircuit.updateMany, update: prisma.providerCircuit.update };
  t.after(() => Object.assign(prisma.providerCircuit, original));
  let token: string | null = null;
  let lastStartedAt: Date | null = null;
  const starts: number[] = [];
  Object.assign(prisma.providerCircuit, {
    upsert: async () => ({}), findUnique: async () => ({ lastSuccessAt: lastStartedAt }),
    updateMany: async (query: {where:{requestLeaseToken?:string};data:{requestLeaseToken:string|null}}) => {
      if (query.data.requestLeaseToken) {
        if (token) return {count:0}; token=query.data.requestLeaseToken; return {count:1};
      }
      if(query.where.requestLeaseToken===token) {token=null; return {count:1};}
      return {count:0};
    },
    update: async (query: {data:{lastSuccessAt:Date}}) => {
      lastStartedAt=query.data.lastSuccessAt; starts.push(lastStartedAt.getTime()); return {};
    },
  });
  await Promise.all(Array.from({length:3},()=>paceAtsProviderRequest('ATS-manatal',30)));
  assert.equal(starts.length,3);
  assert.ok(starts[1]-starts[0]>=30);
  assert.ok(starts[2]-starts[1]>=30);
  assert.equal(token,null);
  const abort = new AbortController();
  setTimeout(()=>abort.abort(new Error('cancel paced dispatch')),5);
  await assert.rejects(paceAtsProviderRequest('ATS-manatal',1000,abort.signal),/cancel paced dispatch/);
  assert.equal(starts.length,3);
  assert.equal(token,null);
  assert.equal(atsRequestSpacingMs('manatal'),1000);
  assert.equal(atsRequestSpacingMs('workday'),0);
});
