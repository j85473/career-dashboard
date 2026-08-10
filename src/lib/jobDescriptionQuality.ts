export const MIN_SCORABLE_JD_CHARACTERS = 650;

export type JobDescriptionQuality = {
  scorable: boolean;
  reason: string | null;
};

function normalizedDescription(value: string): string {
  return value.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasUsableDuties(text: string): boolean {
  return /\b(?:job description|responsibilities|primary responsibilit(?:y|ies)|what (?:the )?job (?:actually )?is|what you(?:'|’)ll do|what you will do|your impact|the role|in this role|day[- ]to[- ]day|essential functions|key duties)\b/i.test(text)
    || /\b(?:responsible for|own|manage|maintain|lead|develop|build|drive|execute|grow|partner|coordinate|deliver|oversee|generate)\b.{0,100}\b(?:accounts?|customers?|partners?|territor(?:y|ies)|revenue|sales|programs?|relationships?|strategy|growth|business)\b/i.test(text);
}

function hasUsableQualifications(text: string): boolean {
  return /\b(?:qualifications|requirements|what you(?:'|’)ll bring|what you bring|what we(?:'|’)re looking for|minimum qualifications|required experience|preferred qualifications|you have|about you)\b/i.test(text)
    || /\b(?:minimum|required|must|need(?:ed)?|at least|\d+\+?\s+years?|bachelor(?:'s)?|degree|experience (?:in|with|managing|selling|leading))\b/i.test(text);
}

function looksLikePortalShell(text: string): boolean {
  const shellSignal = /\b(?:sign in to apply|log in to apply|create (?:an )?account|candidate login|returning applicant|access denied|enable javascript|javascript is required|search jobs|job cart|saved jobs|no results found)\b/i.test(text);
  return shellSignal && (!hasUsableDuties(text) || !hasUsableQualifications(text));
}

function hasTerminalClosureSignal(text: string): boolean {
  const terminalPattern = /\b(?:job (?:is )?no longer (?:available|active|posted)|position (?:has been|is) filled|posting (?:has been|is) closed)\b/gi;
  for (const match of text.matchAll(terminalPattern)) {
    const matchIndex = match.index || 0;
    const sentenceBoundary = Math.max(
      text.lastIndexOf('.', matchIndex - 1),
      text.lastIndexOf('!', matchIndex - 1),
      text.lastIndexOf('?', matchIndex - 1),
      text.lastIndexOf(';', matchIndex - 1),
      text.lastIndexOf('\n', matchIndex - 1),
    );
    const prefix = text.slice(sentenceBoundary + 1, matchIndex);
    const conditionalApplicationLanguage = /\b(?:if|when|until|once|unless|before|after)\b/i.test(prefix)
      && /\b(?:applications?|applicants?|accept(?:ed|ing)?|review(?:ed|ing)?|posting|requisition|deadline|may|might|could|will)\b/i.test(prefix);
    if (!conditionalApplicationLanguage) return true;
  }
  return false;
}

export function looksLikeInvalidJobDescription(value: string): boolean {
  const text = normalizedDescription(value).toLowerCase();
  if (!text) return true;
  // A bare 404 means nothing on its own: accommodation hotlines are written
  // both 1-888-404-2494 and +1 888 404 2494. Require HTTP/page context.
  const terminalPage = /\b(?:(?:error|status|code|http)\s*:?\s*404\b|404\s*[:–-]?\s*(?:not found|error|page)|page not found|page does not exist|page you (?:are|were) looking for (?:does not|doesn't) exist)\b/i.test(text)
    || hasTerminalClosureSignal(text);
  const cookieOnly = text.length < 2_000
    && /\b(?:cookie preferences|manage cookies|accept all cookies|privacy preference center)\b/.test(text)
    && !/\b(?:responsibilities|qualifications|requirements|what you(?:'|’)ll do)\b/.test(text);
  return terminalPage || cookieOnly || looksLikePortalShell(text);
}

/**
 * Native scoring needs a complete-enough JD, not merely a non-error page.
 * This stricter contract is intentionally separate from the terminal-page
 * detector because short snippets may be useful for discovery but are not
 * sufficient evidence for a qualification decision.
 */
export function assessJobDescriptionQuality(value: string): JobDescriptionQuality {
  const text = normalizedDescription(value);
  if (looksLikeInvalidJobDescription(text)) {
    return { scorable: false, reason: 'expired, closed, login, cookie, or portal shell' };
  }
  if (text.length < MIN_SCORABLE_JD_CHARACTERS) {
    return { scorable: false, reason: `fewer than ${MIN_SCORABLE_JD_CHARACTERS} usable characters` };
  }
  if (/(?:\.\.\.|…)$/.test(text) && text.length < 2_000) {
    return { scorable: false, reason: 'visibly truncated description' };
  }
  if (!hasUsableDuties(text)) {
    return { scorable: false, reason: 'no usable role duties' };
  }
  if (!hasUsableQualifications(text)) {
    return { scorable: false, reason: 'no usable qualifications' };
  }
  return { scorable: true, reason: null };
}

export function isScorableJobDescription(value: string): boolean {
  return assessJobDescriptionQuality(value).scorable;
}
