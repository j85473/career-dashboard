import path from 'node:path';
import { createHash } from 'node:crypto';

export const CANONICAL_SCORING_RESUME_BASENAME = 'JosephLamb_Resume.docx';
export const CANONICAL_SCORING_RESUME_SHA256 = '9ad3e6c9db671d455aab2d903d3d662e81d385883a436663b597286850c77640';
export const CANONICAL_DSI_FORMAL_TITLE = 'Field Sales Representative — Channel Sales';

const CONTACT_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:linkedin|github)\.com\//i,
  /(?:\+?1[.\s-]?)?\(?\d{3}\)?[.\s-]\d{3}[.\s-]\d{4}/,
];

function normalizedVisibleLines(value: string): string[] {
  return value
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Verifies the immutable Workday-resume contract before a native scoring run
 * can lease work or create artifacts. Filename, bytes, and the held DSI title
 * are separate checks on purpose: a renamed or one-line-edited substitute
 * must fail even when the rest of the resume text is identical.
 */
export function assertCanonicalScoringResume(
  filePath: string,
  bytes: Buffer,
  extractedText: string,
): void {
  if (path.basename(filePath) !== CANONICAL_SCORING_RESUME_BASENAME) {
    throw new Error(
      `Scoring resume must be named ${CANONICAL_SCORING_RESUME_BASENAME}`,
    );
  }

  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== CANONICAL_SCORING_RESUME_SHA256) {
    throw new Error(
      `Scoring resume SHA-256 must be ${CANONICAL_SCORING_RESUME_SHA256}; received ${digest}`,
    );
  }

  const lines = normalizedVisibleLines(extractedText);
  const formalTitleLine = lines.find((line) => (
    line.startsWith(`${CANONICAL_DSI_FORMAL_TITLE} ·`)
    || line === CANONICAL_DSI_FORMAL_TITLE
  ));
  if (!formalTitleLine) {
    throw new Error(
      `Scoring resume must use the formal DSI title ${CANONICAL_DSI_FORMAL_TITLE}`,
    );
  }

  if (lines.some((line) => /^Channel Account Manager\s*[·|—-]/i.test(line))) {
    throw new Error(
      'Channel Account Manager is a supported function, not the candidate\'s held DSI title',
    );
  }
}

function canonicalResumeLines(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => (
      index > 4 || !CONTACT_PATTERNS.some((pattern) => pattern.test(line))
    ))
    // DOCX extractors may represent manual line breaks inside one paragraph as
    // either newlines, spaces, or concatenated text. Ignoring whitespace keeps
    // prompt formatting readable while still requiring exact visible wording.
    .join('')
    .replace(/\s+/g, '');
}

export function evaluatorResumeSection(
  prompt: string,
  nextSectionHeading: string,
): string {
  const startMarker = '## 1. Candidate Resume\n';
  const start = prompt.indexOf(startMarker);
  if (start === -1) throw new Error('Evaluator prompt is missing its Candidate Resume section');

  const contentStart = start + startMarker.length;
  const end = prompt.indexOf(`\n${nextSectionHeading}`, contentStart);
  if (end === -1) {
    throw new Error(`Evaluator prompt is missing its ${nextSectionHeading} boundary`);
  }
  return prompt.slice(contentStart, end);
}

export function assertEvaluatorResumeMatches(
  prompt: string,
  nextSectionHeading: string,
  currentResume: string,
  evaluatorName: string,
): void {
  const current = canonicalResumeLines(currentResume);
  if (!current) throw new Error('The current baseline resume is empty');
  const baked = canonicalResumeLines(evaluatorResumeSection(prompt, nextSectionHeading));
  if (baked !== current) {
    throw new Error(
      `The baked ${evaluatorName} evaluator resume does not match the current baseline resume (contact details ignored)`,
    );
  }
}
