import { createHash } from 'node:crypto';

const NON_PREFERENCE_REASONS = new Set([
  'expired',
  'already applied',
  'experience mismatch',
  'location mismatch',
]);

const QUALIFICATION_RULE_PATTERNS = [
  /roles? that strongly require highly specific .* experience .* candidate does not explicitly possess/i,
  /roles? requiring deep technical, code-literate, or saas infrastructure\/architectural experience that the candidate does not possess/i,
  /\b(?:roles?|jobs?|positions?)\b.{0,35}\b(?:requiring|needing|that require|that need)\b.{0,120}\b(?:experience|degree|license|licensure|credential|certification)\b/i,
  /\b(?:candidate|applicant)\b.{0,100}\b(?:lacks?|does not (?:have|possess)|doesn't (?:have|possess)|has no)\b/i,
];

const OVERBROAD_POST_SALE_RULE = /general customer success manager \(csm\).*account management roles? not strictly focused on channel sales\/partner enablement/i;
const CALIBRATED_POST_SALE_RULE = 'post-sale roles dominated by support, training, implementation, or internal operations without commercial ownership, account growth, or strategic partner scope.';

export type ContextRuleDimension =
  | 'selling_motion'
  | 'work_arrangement'
  | 'employment_type'
  | 'role_function'
  | 'employer'
  | 'industry'
  | 'location'
  | 'other';

export type ContextRuleScope = 'aim_only';

export type TypedContextRule = {
  id: string;
  text: string;
  dimension: ContextRuleDimension;
  scope: ContextRuleScope;
  source: 'legacy_rules_text';
  sourceDecisionId: null;
  confidence: 'legacy_unverified';
  active: true;
};

export type ContextRuleValidation = {
  accepted: TypedContextRule[];
  rejected: Array<{ text: string; reason: string }>;
};

const IMMUTABLE_POSITIVE_TARGET_CONFLICTS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:wireless technology|wireless industry|telecom(?:munications)?|carrier ecosystem)\b/i,
    reason: 'conflicts with the immutable telecom/carrier target domain',
  },
  {
    pattern: /^(?:(?:all|any|general)\s+)?(?:(?:roles?|jobs?|positions?)\s+(?:with|requiring|needing)\s+)?(?:high[- ]travel(?: field sales)?|frequent[- ]travel(?: requirements?|field sales)?|field sales|channel sales|partner enablement|distributor sales)(?:\s+(?:roles?|jobs?|requirements?))?[.!]?$/i,
    reason: 'conflicts with an immutable positive role or travel target',
  },
  {
    pattern: /(?:\b(?:all|any|every)\b.{0,50}|\b(?:channel|field|partner|distributor)\s+(?:roles?|jobs?|positions?)\b.{0,50})\b(?:international|national|western|non[- ]midwest)\b.{0,40}\b(?:territor(?:y|ies)|regions?|coverage)\b/i,
    reason: 'conflates travel territory with the candidate work base',
  },
  {
    pattern: /\b(?:remote|home[- ]based)\b.{0,60}\b(?:outside|beyond|not in)\b.{0,30}\b(?:midwest|minnesota)\b/i,
    reason: 'blanket remote-territory rejection conflicts with Minneapolis-based US-remote eligibility',
  },
  {
    pattern: /\b(?:regional|field|channel|partner|distributor)\b.{0,80}\b(?:roles?|jobs?|sales)\b.{0,80}\b(?:cover(?:ing|s|ed)?|territor(?:y|ies)|regions?)\b.{0,60}\b(?:outside|beyond|non[- ]?)\s*(?:the\s+)?(?:midwest|minnesota)\b/i,
    reason: 'conflates a travel territory with the candidate work base',
  },
  {
    pattern: /\b(?:international|global|western)\b.{0,40}\b(?:territory management|territor(?:y|ies)|regions?|coverage)\b/i,
    reason: 'blanket territory rejection conflicts with eligible high-travel channel work',
  },
  {
    pattern: /\bdirect\s+smb\s+customer[- ]facing\s+roles?\b/i,
    reason: 'overbroad customer-segment rule can reject commercially owned account-growth roles',
  },
];

function stableLegacyRuleId(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .toLocaleLowerCase('en-US');
  return `legacy-${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function contextRuleDimension(text: string): ContextRuleDimension {
  if (/\b(?:cold|outbound|prospect|hunter|new[- ]logo|farming|retention|renewal)\b/i.test(text)) return 'selling_motion';
  if (/\b(?:remote|hybrid|onsite|on[- ]site|in[- ]office|home[- ]based)\b/i.test(text)) return 'work_arrangement';
  if (/\b(?:1099|contract|part[- ]time|full[- ]time)\b/i.test(text)) return 'employment_type';
  if (/\b(?:staffing|recruit(?:er|ing)|employer|company)\b/i.test(text)) return 'employer';
  if (/\b(?:territor(?:y|ies)|location|midwest|minnesota|international|region)\b/i.test(text)) return 'location';
  if (/\b(?:industry|technology|telecom|wireless|medical|healthcare|retail|logistics)\b/i.test(text)) return 'industry';
  if (/\b(?:sales|account|customer success|support|operations|enablement|channel|partner)\b/i.test(text)) return 'role_function';
  return 'other';
}

export function contextRuleConflict(rule: string): string | null {
  if (QUALIFICATION_RULE_PATTERNS.some((pattern) => pattern.test(rule))) {
    return 'qualification gaps belong in Experience, not Context/Aim';
  }
  return IMMUTABLE_POSITIVE_TARGET_CONFLICTS.find(({ pattern }) => pattern.test(rule))?.reason || null;
}

export function typedContextRule(rule: string): TypedContextRule {
  const text = rule.trim();
  return {
    id: stableLegacyRuleId(text),
    text,
    dimension: contextRuleDimension(text),
    scope: 'aim_only',
    source: 'legacy_rules_text',
    sourceDecisionId: null,
    confidence: 'legacy_unverified',
    active: true,
  };
}

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

function calibratedContextRule(rule: string): string | null {
  // Qualification gaps belong in experience scoring. Feeding them into Aim
  // teaches the system to dislike whole role families instead of evaluating the
  // actual mandatory requirements on each job.
  if (OVERBROAD_POST_SALE_RULE.test(rule)) return CALIBRATED_POST_SALE_RULE;
  if (contextRuleConflict(rule)) return null;
  return rule;
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
      && contextRuleConflict(line.slice(2)) === null
    ));
}

export function validateTypedContextRules(value: string | null | undefined): ContextRuleValidation {
  const sanitized = contextRulesForNativeScoring(value);
  const accepted: TypedContextRule[] = [];
  const rejected: ContextRuleValidation['rejected'] = [];

  let section: 'negative' | 'other' | 'none' = 'none';
  for (const rawLine of (value || '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '').trim();
    if (!line) continue;
    if (/^DO REJECT:$/i.test(line)) {
      section = 'negative';
      continue;
    }
    if (/^(?:DO ACCEPT|POSITIVE|FAVOR|PREFER|INTERESTED|OPEN TO)\b.*:?$/i.test(line)) {
      section = 'other';
      continue;
    }
    const explicitNegative = /^(?:DO REJECT\b:?|REJECT\b:?|NEGATIVE\s*:)/i.test(line);
    if (!explicitNegative && section !== 'negative') continue;
    const cleaned = line
      .replace(/^(?:DO REJECT|REJECT)\b:?\s*/i, '')
      .replace(/^NEGATIVE\s*:\s*/i, '')
      .trim();
    const conflict = contextRuleConflict(cleaned);
    if (conflict) rejected.push({ text: cleaned, reason: conflict });
  }

  for (const line of sanitized.split(/\r?\n/).slice(1)) {
    const text = line.replace(/^[-*]\s*/, '').trim();
    if (text && !/^No established negative preference rules\.$/i.test(text)) {
      accepted.push(typedContextRule(text));
    }
  }
  return { accepted, rejected };
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
    if (cleaned) {
      const calibrated = calibratedContextRule(cleaned);
      if (calibrated) rules.push(calibrated);
    }
  }

  const unique = [...new Map(rules.map((rule) => [rule.toLowerCase(), rule])).values()];
  if (unique.length === 0) return 'DO REJECT:\n- No established negative preference rules.';
  const result = `DO REJECT:\n${unique.map((rule) => `- ${rule}`).join('\n')}`;
  return result.slice(0, 12_000).trim();
}
