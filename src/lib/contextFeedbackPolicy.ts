const NON_PREFERENCE_REASONS = new Set([
  'expired',
]);

export function normalizedPassReason(reason: string | null | undefined): string {
  return (reason || '').trim();
}

export function isContextFeedbackEligible(
  status: string,
  reason: string | null | undefined,
): boolean {
  const normalized = normalizedPassReason(reason);
  return status === 'passed'
    && normalized.length > 0
    && !NON_PREFERENCE_REASONS.has(normalized.toLowerCase())
    && !/\bexpired\b/i.test(normalized);
}

/**
 * `contextBatched` is a legacy boolean. `true` means that the lifecycle
 * decision must not enter the native context queue. Applied/interviewing jobs
 * are deliberately terminal for context purposes.
 */
export function contextDecisionAlreadyHandled(
  status: string,
  reason: string | null | undefined,
): boolean {
  return !isContextFeedbackEligible(status, reason);
}

export function negativeOnlyContextRules(value: string): boolean {
  const normalized = value.trim();
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[0] === 'DO REJECT:'
    && lines.length >= 2
    && lines.slice(1).every((line) => (
      line.startsWith('- ')
      && !/\b(?:DO ACCEPT|POSITIVE|FAVOR|PREFER|INTERESTED|OPEN TO|positive_applied)\b/i.test(line)
      && !/\bexpired\b/i.test(line)
    ));
}

export function contextRulesForNativeScoring(value: string | null | undefined): string {
  const normalized = (value || '').trim();
  if (!normalized) return 'DO REJECT:\n- No established negative preference rules.';

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rules: string[] = [];
  let section: 'negative' | 'other' | 'none' = 'none';
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[-*]\s*/, '').trim();
    if (/^DO REJECT:$/i.test(line)) {
      section = 'negative';
      continue;
    }
    if (/^(?:DO ACCEPT|POSITIVE|FAVOR|PREFER|INTERESTED|OPEN TO)\b.*:?$/i.test(line)) {
      section = 'other';
      continue;
    }
    if (/^[A-Z][A-Z\s/_-]{2,}:$/.test(line) && !/^NEGATIVE\s*:$/i.test(line)) {
      section = 'other';
      continue;
    }
    const explicitNegative = /^(?:DO REJECT\b:?|REJECT\b:?|NEGATIVE\s*:)/i.test(line);
    if (!explicitNegative && section !== 'negative') continue;
    if (/\bpositive_applied\b|\bexpired\b/i.test(line)) continue;
    const cleaned = line
      .replace(/^DO REJECT\b:?\s*/i, '')
      .replace(/^REJECT\b:?\s*/i, '')
      .replace(/^NEGATIVE\s*:\s*/i, '')
      .trim();
    if (cleaned) rules.push(cleaned);
  }

  const unique = [...new Map(rules.map((rule) => [rule.toLowerCase(), rule])).values()];
  if (unique.length === 0) return 'DO REJECT:\n- No established negative preference rules.';
  const result = `DO REJECT:\n${unique.map((rule) => `- ${rule}`).join('\n')}`;
  return result.slice(0, 12_000).trim();
}
