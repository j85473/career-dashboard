const FEEDBACK_START = '<!-- WILDCARD_USER_FEEDBACK_V1:START -->';
const FEEDBACK_END = '<!-- WILDCARD_USER_FEEDBACK_V1:END -->';

export const MAX_WILDCARD_FEEDBACK_ENTRIES = 20;
export const MAX_WILDCARD_FEEDBACK_PROMPT_CHARS = 4_000;

export type WildcardFeedbackDecision = 'promote' | 'pass';

export type WildcardFeedbackInput = {
  decision: WildcardFeedbackDecision;
  title: string;
  company: string;
  reason: string;
};

function compactField(value: string, maximum: number): string {
  return value
    .replaceAll(FEEDBACK_START, '')
    .replaceAll(FEEDBACK_END, '')
    .replace(/[|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

export function splitWildcardProfile(profileText: string): {
  baseProfileText: string;
  feedbackEntries: string[];
} {
  const start = profileText.indexOf(FEEDBACK_START);
  if (start < 0) {
    return { baseProfileText: profileText.trim(), feedbackEntries: [] };
  }

  const end = profileText.indexOf(FEEDBACK_END, start + FEEDBACK_START.length);
  if (end < 0) {
    // Treat a malformed marker as ordinary profile content rather than deleting it.
    return { baseProfileText: profileText.trim(), feedbackEntries: [] };
  }

  const before = profileText.slice(0, start).trim();
  const after = profileText.slice(end + FEEDBACK_END.length).trim();
  const feedbackEntries = profileText
    .slice(start + FEEDBACK_START.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .slice(-MAX_WILDCARD_FEEDBACK_ENTRIES);

  return {
    baseProfileText: [before, after].filter(Boolean).join('\n\n'),
    feedbackEntries,
  };
}

export function appendWildcardFeedback(profileText: string, input: WildcardFeedbackInput): string {
  const { baseProfileText, feedbackEntries } = splitWildcardProfile(profileText);
  const title = compactField(input.title, 180) || 'Unknown role';
  const company = compactField(input.company, 180) || 'Unknown company';
  const reason = compactField(input.reason, 600);
  if (!reason) throw new Error('Wildcard feedback reason is required');

  const polarity = input.decision === 'promote' ? 'POSITIVE_OVERRIDE' : 'NEGATIVE_PASS';
  const entry = `- ${polarity} | ${title} @ ${company} | ${reason}`;
  const nextEntries = [...feedbackEntries.filter((existing) => existing !== entry), entry]
    .slice(-MAX_WILDCARD_FEEDBACK_ENTRIES);
  const base = baseProfileText || '- No wildcard profile has been established.';

  return `${base}\n\n${FEEDBACK_START}\n## Explicit user decisions (wildcard only)\n${nextEntries.join('\n')}\n${FEEDBACK_END}`;
}

export function wildcardFeedbackForPrompt(profileText: string): {
  baseProfileText: string;
  explicitFeedback: string;
} {
  const { baseProfileText, feedbackEntries } = splitWildcardProfile(profileText);
  const selected: string[] = [];
  let usedCharacters = 0;

  for (let index = feedbackEntries.length - 1; index >= 0; index -= 1) {
    const entry = feedbackEntries[index];
    const nextLength = entry.length + (selected.length > 0 ? 1 : 0);
    if (usedCharacters + nextLength > MAX_WILDCARD_FEEDBACK_PROMPT_CHARS) break;
    selected.unshift(entry);
    usedCharacters += nextLength;
  }

  return {
    baseProfileText: baseProfileText || '- No wildcard profile has been established.',
    explicitFeedback: selected.join('\n'),
  };
}
