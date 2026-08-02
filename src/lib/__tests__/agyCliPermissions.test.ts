import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeAgyCliPermissions } from '../agyCliPermissions';

const requestGrant = 'command(npm run --silent scoring:request -- --source agy)';
const nextGrant = 'command(npm run --silent scoring:next -- --request UUID)';

test('Agy CLI permissions add only missing exact grants and preserve settings', () => {
  const original = {
    theme: 'dark',
    permissions: {
      deny: ['command(rm)'],
      allow: ['command(git log)', requestGrant],
    },
  };
  const merged = mergeAgyCliPermissions(original, [requestGrant, nextGrant]);

  assert.equal(merged.changed, true);
  assert.deepEqual(merged.settings, {
    theme: 'dark',
    permissions: {
      deny: ['command(rm)'],
      allow: ['command(git log)', requestGrant, nextGrant],
    },
  });
  assert.deepEqual(original.permissions.allow, ['command(git log)', requestGrant]);
});

test('Agy CLI permission merge is idempotent', () => {
  const original = { permissions: { allow: [requestGrant, nextGrant] } };
  const merged = mergeAgyCliPermissions(original, [requestGrant, nextGrant]);
  assert.equal(merged.changed, false);
  assert.equal(merged.settings, original);
});

test('Agy CLI permission merge replaces only named obsolete grants', () => {
  const obsolete = 'command(npm run --silent scoring:next -- --request old-regex)';
  const original = { permissions: { allow: ['command(git log)', obsolete] } };
  const merged = mergeAgyCliPermissions(original, [requestGrant, nextGrant], [obsolete]);
  assert.deepEqual(
    (merged.settings.permissions as { allow: string[] }).allow,
    ['command(git log)', requestGrant, nextGrant],
  );
});

test('Agy CLI permission merge fails closed on malformed allow rules', () => {
  assert.throws(
    () => mergeAgyCliPermissions({ permissions: { allow: 'command(*)' } }, [requestGrant]),
    /must be an array of strings/,
  );
});
