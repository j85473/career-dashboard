// Pay-transparency boilerplate routinely says a posting may be removed "if the
// position is filled", which describes a possible future, not a closed job.
// Healthy descriptions were being discarded over a conditional clause.
const CONDITIONAL = '(?<!(?:until|if|when|once|unless|before|after) (?:this |that |the )?)';

export function looksLikeInvalidJobDescription(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return true;
  const terminalPage = new RegExp(
    // A bare 404 means nothing on its own: accommodation hotlines are written
    // both 1-888-404-2494 and +1 888 404 2494, so excluding phone formats is
    // endless. Require the HTTP context that makes the number a status code.
    `\\b(?:(?:error|status|code|http)\\s*:?\\s*404\\b|\\b404\\s*[:–-]?\\s*(?:not found|error|page)`
    + `|page not found|page does not exist|page you (?:are|were) looking for (?:does not|doesn't) exist`
    + `|${CONDITIONAL}job (?:is )?no longer (?:available|active|posted)`
    + `|${CONDITIONAL}position (?:has been|is) filled`
    + `|${CONDITIONAL}posting (?:has been|is) closed)\\b`,
  ).test(text);
  const cookieOnly = text.length < 2_000
    && /\b(?:cookie preferences|manage cookies|accept all cookies|privacy preference center)\b/.test(text)
    && !/\b(?:responsibilities|qualifications|requirements|what you(?:'|’)ll do)\b/.test(text);
  return terminalPage || cookieOnly;
}
