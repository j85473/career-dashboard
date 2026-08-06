const CONTACT_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:linkedin|github)\.com\//i,
  /(?:\+?1[.\s-]?)?\(?\d{3}\)?[.\s-]\d{3}[.\s-]\d{4}/,
];

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
