export function looksLikeInvalidJobDescription(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return true;
  const terminalPage = /\b(?:404|page not found|page does not exist|page you (?:are|were) looking for (?:does not|doesn't) exist|job (?:is )?no longer (?:available|active|posted)|position (?:has been|is) filled|posting (?:has been|is) closed)\b/.test(text);
  const cookieOnly = text.length < 2_000
    && /\b(?:cookie preferences|manage cookies|accept all cookies|privacy preference center)\b/.test(text)
    && !/\b(?:responsibilities|qualifications|requirements|what you(?:'|’)ll do)\b/.test(text);
  return terminalPage || cookieOnly;
}
