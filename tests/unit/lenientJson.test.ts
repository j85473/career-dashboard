import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonWithControlCharacterRecovery } from '../../src/lib/lenientJson';

test('recovers a string carrying raw newlines, tabs and carriage returns', () => {
  const raw = '{"description":"line one\nline two\ttabbed\rreturned","ok":true}';
  assert.throws(() => JSON.parse(raw), 'the input must genuinely be invalid JSON');
  const parsed = parseJsonWithControlCharacterRecovery(raw) as Record<string, unknown>;
  assert.equal(parsed.description, 'line one\nline two\ttabbed\rreturned');
  assert.equal(parsed.ok, true);
});

test('leaves the document structure alone', () => {
  // The newlines between tokens are the document's own formatting. Escaping
  // those would corrupt the JSON rather than repair it.
  const raw = '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}';
  assert.deepEqual(parseJsonWithControlCharacterRecovery(raw), { a: 1, b: [2, 3] });
});

test('does not double-escape an already-escaped sequence', () => {
  const raw = '{"a":"already\\nescaped","b":"trailing backslash pair \\\\"}';
  const parsed = parseJsonWithControlCharacterRecovery(raw) as Record<string, unknown>;
  assert.equal(parsed.a, 'already\nescaped');
  assert.equal(parsed.b, 'trailing backslash pair \\');
});

test('an escaped quote does not end the string early', () => {
  // If the escape state were tracked wrongly, the parser would think the string
  // closed at the inner quote and treat the following newline as structure.
  const raw = '{"a":"he said \\"hi\\"\nthen left"}';
  const parsed = parseJsonWithControlCharacterRecovery(raw) as Record<string, unknown>;
  assert.equal(parsed.a, 'he said "hi"\nthen left');
});

test('returns null for JSON broken beyond this defect rather than guessing', () => {
  assert.equal(parseJsonWithControlCharacterRecovery('{"a":'), null);
  assert.equal(parseJsonWithControlCharacterRecovery('not json at all'), null);
});
