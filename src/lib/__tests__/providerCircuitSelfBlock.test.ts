import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  classifyProviderFailure,
  effectiveProviderCircuitState,
  providerFailurePolicy,
} from '../ingestionControl';

test('the circuit\'s own rejection is not classified as a provider failure', () => {
  for (const message of [
    'Indeed Details request blocked by circuit_open',
    'ATS-smartrecruiters Details request blocked by circuit_open',
  ]) {
    assert.equal(classifyProviderFailure(new Error(message)), 'circuit_blocked');
  }
});

test('real provider failures are still classified normally', () => {
  assert.equal(classifyProviderFailure(new Error('HTTP 429 from provider')), 'rate_limited');
  assert.equal(classifyProviderFailure(new Error('HTTP 403 forbidden')), 'credentials');
  assert.equal(classifyProviderFailure(new Error('Adzuna request blocked by daily_budget')), 'budget_exhausted');
  assert.equal(classifyProviderFailure(new Error('socket hang up')), 'provider_error');
  assert.equal(classifyProviderFailure(new Error('request timed out')), 'timeout');
});

test('Prisma transaction contention is internal persistence, not an ATS provider failure', () => {
  assert.equal(classifyProviderFailure(Object.assign(
    new Error('Transaction API error: Unable to start a transaction in the given time.'),
    { code: 'P2028' },
  )), 'internal_persistence');
  assert.equal(classifyProviderFailure(Object.assign(
    new Error('Transaction failed due to a write conflict or a deadlock.'),
    { code: 'P2034' },
  )), 'internal_persistence');
  assert.equal(classifyProviderFailure(
    new Error('Transaction API error: Unable to start a transaction in the given time.'),
  ), 'internal_persistence');
});

test('an old false circuit caused by database contention no longer blocks ATS', () => {
  assert.equal(effectiveProviderCircuitState({
    state: 'open',
    lastError: 'Transaction API error: Unable to start a transaction in the given time.',
  }), 'closed');
  assert.equal(effectiveProviderCircuitState({ state: 'open', lastError: 'HTTP 429 from provider' }), 'open');
  assert.equal(effectiveProviderCircuitState({ state: 'closed', lastError: null }), 'closed');
});

test('recordProviderFailure returns before touching the circuit for a self-block', () => {
  // Production evidence for why: ATS-smartrecruiters Details reached 157
  // consecutive failures and Indeed Details 139, both with lastError set to
  // "blocked by circuit_open" — the block message, with the original cause
  // overwritten. Neither could ever close, because each blocked attempt
  // counted as a fresh failure and re-opened the circuit.
  const source = readFileSync(path.join(process.cwd(), 'src/lib/ingestionControl.ts'), 'utf8');
  const body = source.slice(
    source.indexOf('export async function recordProviderFailure'),
    source.indexOf('export async function recordProviderSuccess'),
  );
  const guardIndex = body.indexOf("classification === 'circuit_blocked' || classification === 'internal_persistence'");
  assert.ok(guardIndex > 0, 'the self-block guard is missing');
  assert.ok(
    guardIndex < body.indexOf('providerCircuit.upsert'),
    'the guard must return before any circuit write',
  );
});

test('a third ordinary failure opens the circuit, and self-blocks cannot extend it', () => {
  const opened = providerFailurePolicy('provider_error', 2);
  assert.equal(opened.state, 'open');
  assert.equal(opened.consecutiveFailures, 3);

  // The policy itself is unchanged for genuine failures; containment lives in
  // recordProviderFailure, which never reaches the policy for a self-block.
  const escalated = providerFailurePolicy('provider_error', 156);
  assert.equal(escalated.consecutiveFailures, 157);
});

test('ingestion does not record a circuit-blocked request as a source error', () => {
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  const markSourceError = ingestion.slice(
    ingestion.indexOf('function markSourceError'),
    ingestion.indexOf('function markSourceSuccess'),
  );
  const guardIndex = markSourceError.indexOf("classification === 'circuit_blocked'");
  assert.ok(guardIndex > 0, 'markSourceError has no circuit-block carve-out');
  assert.ok(
    guardIndex < markSourceError.indexOf('providerFailures.add(source)'),
    'the carve-out must return before the source is marked failing',
  );
});
