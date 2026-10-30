import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

interface Merge {
  (target: unknown, source: unknown, options?: Record<string, unknown>): Record<string, unknown>;
  all(values: unknown[], options?: Record<string, unknown>): Record<string, unknown>;
}

const rootRequire = createRequire(path.resolve('package.json'));
const browserRequire = createRequire(rootRequire.resolve('puppeteer-extra'));
const preferencesRequire = createRequire(rootRequire.resolve('puppeteer-extra-plugin-user-preferences'));
const merge: Merge = browserRequire('deepmerge');
const malicious = () => JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}},"prototype":{"isAdmin":true},"safe":1}');

function assertSafe(value: unknown) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
  assert.equal('isAdmin' in value, false, 'returned objects must not inherit attacker-controlled flags');
  for (const key of ['__proto__', 'constructor', 'prototype']) assert.equal(Object.hasOwn(value, key), false);
  for (const child of Object.values(value)) assertSafe(child);
}

test('both browser consumers resolve to the committed security fork', () => {
  for (const consumer of [browserRequire, preferencesRequire]) {
    assert.equal(consumer.resolve('deepmerge'), path.resolve('vendor/deepmerge/index.js'));
    assert.equal(consumer('deepmerge/package.json').name, '@career-dashboard/deepmerge');
  }
});

test('source keys cannot poison null-prototype, primitive, or already-poisoned targets', () => {
  for (const target of [Object.create(null), null, undefined, 0, false, malicious()]) {
    const result = merge(target, malicious());
    assertSafe(result);
    assert.equal(result.safe, 1);
  }
});

test('the target copy path, nested merges, arrays and merge.all reject prototype keys too', () => {
  for (const result of [
    merge(malicious(), {}),
    merge({ session: null }, { session: malicious() }),
    merge({}, { sessions: [malicious()] }),
    merge.all([malicious(), { session: malicious() }]),
  ]) assertSafe(result);
  assert.equal(Object.hasOwn(Object.prototype, 'isAdmin'), false);
});

test('forbidden getters are skipped before reading values and failing proxy guards fail closed', () => {
  const payload = Object.create(null);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    Object.defineProperty(payload, key, { enumerable: true, get() { assert.fail('forbidden getters must not run'); } });
  }
  assertSafe(merge(payload, {}));
  assertSafe(merge(Object.create(null), payload));
  const target = new Proxy({}, { has() { throw Error('unavailable property check'); } });
  assert.deepEqual(merge(target, { safe: 1 }), {});
});

test('ordinary launch options, arrays, symbols, special values and custom merging remain compatible', () => {
  const defaults = { args: ['--first'], preferences: { language: 'en' } };
  const options = { args: ['--second'], preferences: { font: 22 }, headless: true };
  const result = merge(defaults, options);
  assert.deepEqual(result, { args: ['--first', '--second'], preferences: { language: 'en', font: 22 }, headless: true });
  assert.notEqual(result.preferences, defaults.preferences);
  assert.deepEqual(defaults, { args: ['--first'], preferences: { language: 'en' } });
  assert.deepEqual(merge(defaults, options, { arrayMerge: (_target: unknown[], source: unknown[]) => source }).args, ['--second']);
  const symbol = Symbol('preference');
  const date = new Date('2026-10-30T00:00:00Z');
  const expression = /safe/;
  assert.deepEqual(merge({}, { [symbol]: true, date, expression }), { [symbol]: true, date, expression });
  assert.equal(merge({}, { preferences: defaults.preferences }, { clone: false }).preferences, defaults.preferences);
});

test('the real user-preferences plugin still combines plugin and caller settings safely', async () => {
  const preferences = rootRequire('puppeteer-extra-plugin-user-preferences')({
    userPrefs: { webkit: { webprefs: { default_font_size: 22 } } },
  });
  preferences.getDataFromPlugins = () => [
    { value: { webkit: { webprefs: { default_font_family: 'Arial' } } } },
    { value: { session: malicious() } },
  ];
  await preferences.beforeLaunch({});
  const combined = preferences.combinedPrefs;
  assertSafe(combined);
  assert.deepEqual(combined.webkit.webprefs, { default_font_size: 22, default_font_family: 'Arial' });
  assert.deepEqual(JSON.parse(preferences.data[0].value.contents), combined);
});
