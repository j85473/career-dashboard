import { createHash } from 'node:crypto';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function normalizeScoringText(value: string): string {
  if (value.includes('\u0000')) throw new Error('scoring text must not contain NUL');
  if (UNPAIRED_SURROGATE.test(value)) throw new Error('scoring text must contain valid Unicode');
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

function assertJsonValue(value: unknown, path = '$'): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must not contain a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') throw new Error(`${path} is not a JSON value`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain JSON object`);
  for (const [key, item] of Object.entries(value)) {
    normalizeScoringText(key);
    assertJsonValue(item, `${path}.${key}`);
  }
}

/** RFC 8785/JCS serialization for parsed JSON values. */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  const encode = (item: JsonValue): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') {
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
  };
  return encode(value);
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function normalizedTextSha256(value: string): string {
  return createHash('sha256').update(normalizeScoringText(value), 'utf8').digest('hex');
}

export function assertIntegerJson(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} must contain integers only`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertIntegerJson(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertIntegerJson(item, `${path}.${key}`);
  }
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export function codePointSlice(value: string, start: number, end: number): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error('code-point span is invalid');
  }
  return [...value].slice(start, end).join('');
}

export function assertExactCodePointQuote(
  source: string,
  span: { startCodePoint: number; endCodePoint: number },
  exactQuote: string,
): void {
  const normalized = normalizeScoringText(source);
  if (span.endCodePoint > codePointLength(normalized)) throw new Error('code-point span exceeds source');
  if (codePointSlice(normalized, span.startCodePoint, span.endCodePoint) !== exactQuote) {
    throw new Error('exact quote does not match the source code-point span');
  }
}
