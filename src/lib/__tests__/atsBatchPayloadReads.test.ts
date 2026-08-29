import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('src/lib/atsAcquisition.ts', 'utf8');

function functionBody(name: string, endMarker: string) {
  const start = source.indexOf(name);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} not found after ${name}`);
  return source.slice(start, end);
}

test('the batch claim probes for a candidate id without detoasting the payload', () => {
  const claim = functionBody(
    'export async function claimNextAtsIngestionBatch',
    'export async function heartbeatAtsBatchProcessing',
  );
  const probe = claim.slice(0, claim.indexOf('const leaseToken'));
  assert.match(probe, /select:\s*\{\s*id:\s*true\s*\}/);
});

test('the completion receipt never re-reads or re-hashes the payload it was handed', () => {
  const completion = functionBody(
    'export async function completeAtsBatchProcessing',
    'export async function failAtsBatchProcessing',
  );
  // Selecting `payload` here detoasted the whole board once per 25-job chunk.
  assert.equal(/payload:\s*true/.test(completion), false);
  assert.equal(/payloadHash\(/.test(completion), false);
  assert.match(completion, /computedPayloadHash:\s*input\.verifiedPayloadHash/);
  // The cheap scalar columns still carry the integrity decision.
  assert.match(completion, /payloadHash:\s*true/);
});

test('a payload that changed between claim and completion fails closed into retry', () => {
  const completion = functionBody(
    'export async function completeAtsBatchProcessing',
    'export async function failAtsBatchProcessing',
  );
  const guard = completion.slice(0, completion.indexOf('const payloadJobCount'));
  assert.match(guard, /batch\.payloadHash !== input\.verifiedPayloadHash/);
  assert.match(guard, /batch\.jobCount !== input\.verifiedPayloadJobCount/);
  assert.match(guard, /releaseAtsProcessingLeaseForRetry/);
  // The guard must precede any cursor advance or terminal write.
  assert.ok(
    completion.indexOf('releaseAtsProcessingLeaseForRetry') < completion.indexOf('planAtsProcessingTurn'),
    'drift guard must run before the turn is planned',
  );
});

test('the claim hands its verified payload facts to whoever completes the chunk', () => {
  const claim = functionBody(
    'export async function claimNextAtsIngestionBatch',
    'export async function heartbeatAtsBatchProcessing',
  );
  assert.match(claim, /verifiedPayloadJobCount:\s*allJobs\.length/);
  assert.match(claim, /verifiedPayloadHash:\s*computedPayloadHash/);
  // The same hash still gates the structural check, so it is computed once.
  assert.match(claim, /computedPayloadHash !== batch\.payloadHash/);
  assert.equal(claim.split('payloadHash(jsonObject(batch.metadata), allJobs)').length - 1, 1);
});

test('every completion call site forwards the facts its own claim verified', () => {
  for (const path of ['src/lib/jobIngestion.ts', 'src/app/api/pipeline/run/route.ts']) {
    const text = readFileSync(path, 'utf8');
    const callIndex = text.indexOf('completeAtsBatchProcessing({');
    assert.notEqual(callIndex, -1, path);
    const call = text.slice(callIndex, callIndex + 600);
    assert.match(call, /verifiedPayloadJobCount:/, path);
    assert.match(call, /verifiedPayloadHash:/, path);
  }
});
