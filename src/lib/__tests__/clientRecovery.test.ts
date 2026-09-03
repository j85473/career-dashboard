import assert from 'node:assert/strict';
import test from 'node:test';

import { readBrowserPreference, writeBrowserPreference } from '../browserStorage';
import { readClientMutationResponse } from '../clientMutationResponse';

test('blocked storage access and quota failures cannot interrupt navigation', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { get localStorage() { throw new DOMException('Blocked', 'SecurityError'); } },
    });
    assert.equal(readBrowserPreference('activeTab'), null);
    assert.doesNotThrow(() => writeBrowserPreference('activeTab', 'stats'));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: {
        getItem: () => 'stats',
        setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); },
      } },
    });
    assert.equal(readBrowserPreference('activeTab'), 'stats');
    assert.doesNotThrow(() => writeBrowserPreference('activeTab', 'inbox'));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('mutation responses preserve valid acknowledgements and server error messages', async () => {
  const payload = { id: 'job-1', status: 'inbox' };
  assert.deepEqual(await readClientMutationResponse(Response.json(payload), 'Failed'), payload);
  await assert.rejects(readClientMutationResponse(Response.json({ error: 'Job was changed' }, { status: 409 }), 'Failed'), /Job was changed/);
  await assert.rejects(readClientMutationResponse(new Response('Bad gateway', { status: 502 }), 'Could not update job'), /Could not update job/);
});

test('malformed or empty success responses cannot be presented as successful mutations', async () => {
  for (const body of ['<html>Unexpected page</html>', '', 'null', '[]', '{}']) {
    await assert.rejects(readClientMutationResponse(new Response(body), 'Failed'), /Refresh to verify the result before trying again/);
  }
});
