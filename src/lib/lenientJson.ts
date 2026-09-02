/**
 * Parse JSON that a provider emitted with raw control characters in a string.
 *
 * JSON forbids an unescaped newline, carriage return or tab inside a string
 * literal; they must be written `\n`, `\r`, `\t`. Real job boards emit them
 * anyway. Teamtailor puts literal newlines in its JobPosting `description`, so
 * `JSON.parse` threw on the first one and the whole posting was discarded --
 * which cost 17,109 jobs, two thirds of that platform's catalog, their
 * location, because the listing feed carries none and the posting page was the
 * only source. The data was there the whole time, one parse error away.
 *
 * This lives in its own module because both JSON-LD readers need it and they
 * sit on opposite sides of an import cycle: atsApi imports cleanHtmlText from
 * jobIngestion, so jobIngestion cannot import back from atsApi.
 *
 * Use it only as a fallback after a strict `JSON.parse` has already failed.
 * Well-formed documents must never be routed through it -- not because the
 * repair is unsafe, but because a provider emitting malformed JSON is worth
 * keeping visible at the call site rather than normalising away everywhere.
 */
export function parseJsonWithControlCharacterRecovery(raw: string): unknown {
  let repaired = '';
  let inString = false;
  let escaped = false;
  for (const character of raw) {
    if (escaped) {
      // The character after a backslash is already spoken for, whatever it is.
      repaired += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      repaired += character;
      // Outside a string a backslash is not an escape introducer, and treating
      // it as one would swallow the next character's meaning.
      escaped = inString;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      repaired += character;
      continue;
    }
    // Only inside a string literal. The same characters between tokens are the
    // document's own whitespace and must be left exactly as they are.
    if (inString && character === '\n') repaired += '\\n';
    else if (inString && character === '\r') repaired += '\\r';
    else if (inString && character === '\t') repaired += '\\t';
    else repaired += character;
  }
  try {
    return JSON.parse(repaired);
  } catch {
    // Malformed beyond this one class of defect. Returning null keeps the
    // caller's existing "could not read it" path rather than inventing a value.
    return null;
  }
}
