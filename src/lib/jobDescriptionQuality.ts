export const MIN_SCORABLE_JD_CHARACTERS = 650;

/**
 * A keyword list will never enumerate how humans write job postings (it was
 * already widened once and still missed real postings). Past this length, a
 * substantial non-shell description is trusted as real content even when it
 * misses the duties/qualifications vocabulary; below it, a miss is still
 * useful fail-closed evidence alongside the 650-character floor.
 */
export const SUBSTANTIAL_JD_CHARACTERS = 1_500;

export type JobDescriptionQuality = {
  scorable: boolean;
  reason: string | null;
  /**
   * Whether the duties/qualifications vocabulary was found. Present only once
   * the text has cleared the shell/length/truncation checks below. This is
   * signal for prioritisation, not a gate: a substantial description is
   * scorable regardless of these values.
   */
  signals?: {
    hasUsableDuties: boolean;
    hasUsableQualifications: boolean;
  };
};

export type JobDescriptionQualityOptions = {
  /**
   * The text came from a posting-description field in a structured provider
   * response (for example Lever, Ashby, Greenhouse, or Workday), rather than
   * from an arbitrary rendered webpage.
   *
   * Structured posting text still has to clear the terminal-page, minimum
   * length, and visible-truncation checks. Its provenance replaces the brittle
   * requirement for particular English section headings: a complete posting
   * can legitimately use different wording, another language, or no explicit
   * qualifications section at all.
   */
  structuredSource?: boolean;
};

function normalizedDescription(value: string): string {
  return value.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasUsableDuties(text: string): boolean {
  return /\b(?:job description|position summary|position overview|responsibilities|your responsibilities|primary responsibilit(?:y|ies)|job duties|duties include|key accountabilities|key activities|what (?:the )?job (?:actually )?is|what you(?:'|’)ll (?:do|be doing|work on)|what you will (?:do|be doing|work on)|your impact|the role|in this role|day[- ]to[- ]day|essential functions|key duties)\b/i.test(text)
    || /\b(?:this|your) role\b.{0,160}\b(?:includes?|including|involves?|responsib(?:le|ilities)|will|you(?:'|’)ll)\b/i.test(text)
    || /\b(?:responsible for|own|manage|maintain|lead|develop|build|drive|execute|grow|partner|coordinate|deliver|oversee|generate)\b.{0,100}\b(?:accounts?|customers?|partners?|territor(?:y|ies)|revenue|sales|programs?|relationships?|strategy|growth|business)\b/i.test(text);
}

function hasUsableQualifications(text: string): boolean {
  return /\b(?:qualifications|requirements|skills and experience|education and experience|knowledge,? skills,? and abilities|essential criteria|what you(?:'|’)ll (?:bring|need)|what you (?:bring|will need)|what we(?:'|’)re looking for|minimum qualifications|required experience|preferred qualifications|ideal candidate|who you are|you have|about you)\b/i.test(text)
    || /\b(?:minimum|required|must|need(?:ed)?|at least|\d+\+?\s+years?|bachelor(?:'s)?|degree|diploma|certification|licen[cs]e|proficiency (?:in|with)|ability to|previous experience|equivalent experience|experience (?:in|with|managing|selling|leading))\b/i.test(text);
}

function looksLikePortalShell(text: string): boolean {
  const shellSignal = /\b(?:sign in to apply|log in to apply|create (?:an )?account|candidate login|returning applicant|access denied|enable javascript|javascript is required|search jobs|job cart|saved jobs|no results found)\b/i.test(text);
  return shellSignal && (!hasUsableDuties(text) || !hasUsableQualifications(text));
}

function hasTerminalClosureSignal(text: string): boolean {
  const terminalPattern = /\b(?:job (?:is )?no longer (?:available|active|posted)|(?:job|position|posting) (?:is )?no longer accepting applications|applications? (?:are|is) no longer (?:being )?accepted(?: for this (?:job|position|posting))?|position (?:has been|is) filled|(?:job|position|posting|requisition) (?:has been|is) (?:closed|cancelled|canceled|expired))\b/gi;
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

/**
 * A confirmed closed posting is a job disposition, not a JD-recovery failure.
 * Keep this narrower than the general invalid-page detector: login, cookie,
 * 404, and portal-shell responses may still warrant recovery or manual review.
 */
export function isClosedJobPosting(value: string | null | undefined): boolean {
  return hasTerminalClosureSignal(normalizedDescription(value || ''));
}

export function looksLikeInvalidJobDescription(value: string): boolean {
  const text = normalizedDescription(value).toLowerCase();
  if (!text) return true;
  // A bare 404 means nothing on its own: accommodation hotlines are written
  // both 1-888-404-2494 and +1 888 404 2494. Require HTTP/page context.
  const terminalPage = /\b(?:(?:error|status|code|http)\s*:?\s*404\b|404\s*[:–-]?\s*(?:not found|error|page)|page not found|page does not exist|page you (?:are|were) looking for (?:does not|doesn't) exist)\b/i.test(text)
    || isClosedJobPosting(text);
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
export function assessJobDescriptionQuality(
  value: string,
  options: JobDescriptionQualityOptions = {},
): JobDescriptionQuality {
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
  if (options.structuredSource) {
    return { scorable: true, reason: null };
  }

  const signals = {
    hasUsableDuties: hasUsableDuties(text),
    hasUsableQualifications: hasUsableQualifications(text),
  };

  // A substantial description that fetched cleanly is real posting content
  // even when it dodges our vocabulary — company boilerplate up front, duties
  // stated in prose the keyword list doesn't recognise, and so on. Don't fail
  // it back into JD recovery, which will only re-fetch the same page and land
  // on the same verdict forever.
  if (text.length >= SUBSTANTIAL_JD_CHARACTERS) {
    return { scorable: true, reason: null, signals };
  }
  if (!signals.hasUsableDuties) {
    return { scorable: false, reason: 'no usable role duties', signals };
  }
  if (!signals.hasUsableQualifications) {
    return { scorable: false, reason: 'no usable qualifications', signals };
  }
  return { scorable: true, reason: null, signals };
}

export function isScorableJobDescription(
  value: string,
  options: JobDescriptionQualityOptions = {},
): boolean {
  return assessJobDescriptionQuality(value, options).scorable;
}

export function isStructuredAtsSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && /^ATS-[a-z0-9_-]+$/i.test(source);
}
