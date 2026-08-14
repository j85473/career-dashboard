import { codePointLength } from './scoringCanonicalJson';
import type { AimEvidenceEntry, AimFactualVector, AimScoringPolicy, AimTrustedMetadata } from './aimV2Types';

export type AimCompensationRecord = {
  componentType: string;
  lowerCents: number | null;
  upperCents: number | null;
  currency: string | null;
  period: string | null;
  annualizedLowerCents: number | null;
  annualizedUpperCents: number | null;
  geographicApplicability: string;
  cash: boolean;
  recurring: boolean;
  treatment: string;
  inclusion: string;
  sourceEvidenceIds: string[];
  reasonCode: string;
};

export type AimCompensationResult = {
  normalizationVersion: string;
  comparisonState: 'comparable' | 'missing' | 'non_comparable' | 'conflicting';
  currency: string | null;
  period: string | null;
  records: AimCompensationRecord[];
  normalizedAnnualLowerCents: number | null;
  normalizedAnnualUpperCents: number | null;
  upperBoundTotalCashCents: number | null;
  referenceCashCents: number | null;
  provenCashLowerBoundCents: number | null;
  floorCents: number;
  floorOutcome: 'below' | 'at_or_above' | 'fail_open';
  preferencePoints: number;
  reasonCode: string;
  sourceQuestionIds: string[];
  sourceEvidenceIds: string[];
};

type ComponentDefinition = {
  questionId: string;
  componentType: string;
  cash: boolean;
  recurring: boolean;
  treatment: string;
  inclusion: string;
};

const COMPONENTS: readonly ComponentDefinition[] = [
  { questionId: 'S2.CP.Q01', componentType: 'fixed_base', cash: true, recurring: true, treatment: 'fixed', inclusion: 'included' },
  { questionId: 'S2.CP.Q02', componentType: 'fixed_periodic', cash: true, recurring: true, treatment: 'fixed', inclusion: 'included' },
  { questionId: 'S2.CP.Q03', componentType: 'unlabeled_annual_pay', cash: true, recurring: true, treatment: 'unknown_totality', inclusion: 'included' },
  { questionId: 'S2.CP.Q04', componentType: 'ote', cash: true, recurring: true, treatment: 'target', inclusion: 'included' },
  { questionId: 'S2.CP.Q05', componentType: 'total_cash', cash: true, recurring: true, treatment: 'total', inclusion: 'included' },
  { questionId: 'S2.CP.Q06', componentType: 'other_total_compensation', cash: false, recurring: true, treatment: 'total', inclusion: 'unknown' },
  { questionId: 'S2.CP.Q07', componentType: 'commission', cash: true, recurring: true, treatment: 'variable', inclusion: 'included' },
  { questionId: 'S2.CP.Q08', componentType: 'variable', cash: true, recurring: true, treatment: 'variable', inclusion: 'included' },
  { questionId: 'S2.CP.Q09', componentType: 'bonus', cash: true, recurring: true, treatment: 'variable', inclusion: 'included' },
  { questionId: 'S2.CP.Q12', componentType: 'draw', cash: true, recurring: true, treatment: 'draw', inclusion: 'unknown' },
  { questionId: 'S2.CP.Q13', componentType: 'sign_on', cash: true, recurring: false, treatment: 'one_time', inclusion: 'excluded' },
  { questionId: 'S2.CP.Q14', componentType: 'equity', cash: false, recurring: false, treatment: 'noncash', inclusion: 'excluded' },
  { questionId: 'S2.CP.Q15', componentType: 'profit_sharing', cash: true, recurring: true, treatment: 'variable', inclusion: 'unknown' },
] as const;

function evidenceMap(vector: AimFactualVector): Map<string, AimEvidenceEntry> {
  return new Map(vector.evidenceCatalog.map((entry) => [entry.evidenceId, entry]));
}

function questionEvidence(vector: AimFactualVector, questionId: string): AimEvidenceEntry[] {
  const byId = evidenceMap(vector);
  return vector.answers.find((answer) => answer.questionId === questionId)?.evidenceIds.map((id) => byId.get(id)!).filter(Boolean) ?? [];
}

function isYes(vector: AimFactualVector, questionId: string): boolean {
  return vector.answers.find((answer) => answer.questionId === questionId)?.answer === 'yes';
}

function decimalAmountToCents(raw: string, thousands: boolean): number | null {
  const cleaned = raw.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  let cents = BigInt(whole) * BigInt(100) + BigInt((fraction + '00').slice(0, 2));
  if (thousands) cents *= BigInt(1000);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

function parseAmounts(text: string): number[] | null {
  const values: number[] = [];
  const pattern = /(?<![\p{L}\p{N}.])(?:USD\s*|US\$\s*|\$\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([kK])?(?!\s*%)(?![\p{L}\p{N}])/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = `${match[1]}${match[2] === undefined ? '' : `.${match[2]}`}`;
    const cents = decimalAmountToCents(raw, match[3] !== undefined);
    if (cents === null) return null;
    values.push(cents);
  }
  const monetary = values.filter((value) => value >= 100 || /(?:USD|US\$|\$)/u.test(text));
  return [...new Set(monetary)];
}

function explicitCurrency(text: string, globalCurrency: string | null): string | null {
  if (/\bUSD\b|US\$/iu.test(text)) return 'USD';
  return globalCurrency;
}

function explicitPeriod(text: string, globalPeriod: string | null): string | null {
  if (/\b(?:annual|annually|per\s+year|yearly|\/\s*year|p\.a\.)\b/iu.test(text)) return 'annual';
  if (/\b(?:monthly|per\s+month|\/\s*month)\b/iu.test(text)) return 'monthly_fixed';
  if (/\b(?:weekly|per\s+week|\/\s*week)\b/iu.test(text)) return 'weekly_fixed';
  if (/\b(?:hourly|per\s+hour|\/\s*(?:hour|hr))\b/iu.test(text)) return 'hourly_fixed';
  return globalPeriod;
}

function fullTimeAnnualHours(text: string): number | null {
  const annual = text.match(/\b(\d{3,4})\s+(?:scheduled\s+)?hours?\s+(?:per\s+year|annually)\b/iu);
  if (annual) return Number(annual[1]);
  const weekly = text.match(/\b(\d{1,2})\s+hours?\s+(?:per\s+week|weekly)\b/iu);
  if (weekly) return Number(weekly[1]) * 52;
  if (/\bfull[- ]time\b/iu.test(text)) return 2080;
  return null;
}

function annualize(value: number, period: string | null, text: string): number | null {
  if (period === 'annual') return value;
  if (period === 'monthly_fixed') return value * 12;
  if (period === 'weekly_fixed') return value * 52;
  if (period === 'hourly_fixed') {
    const hours = fullTimeAnnualHours(text);
    return hours === null ? null : value * hours;
  }
  return null;
}

function globallyDeclaredCurrency(vector: AimFactualVector): string | null {
  const text = questionEvidence(vector, 'S2.CP.Q18').map((entry) => entry.exactQuote).join('\n');
  return /\bUSD\b|US\$/iu.test(text) ? 'USD' : null;
}

function globallyDeclaredPeriod(vector: AimFactualVector): string | null {
  const text = questionEvidence(vector, 'S2.CP.Q19').map((entry) => entry.exactQuote).join('\n');
  return explicitPeriod(text, null);
}

function geographicApplicability(text: string, metadata: AimTrustedMetadata, locationSpecific: boolean): string {
  if (!locationSpecific) return 'unqualified_role_wide';
  const location = metadata.location?.toLocaleLowerCase('en-US') ?? '';
  const lower = text.toLocaleLowerCase('en-US');
  if (location && lower.includes(location)) return 'exact_role_city_state';
  const city = location.split(',')[0]?.trim();
  if (city && city.length >= 3 && lower.includes(city)) return 'exact_role_city_state';
  if (/\b(?:minnesota|\bmn\b)\b/iu.test(text) && /\b(?:minnesota|\bmn\b)\b/iu.test(location)) return 'minnesota';
  if (/\b(?:nationwide|united states|u\.s\.|usa)\b/iu.test(text)) return 'nationwide_united_states';
  return 'not_deterministically_applicable';
}

function geographyRank(value: string): number {
  if (value === 'exact_role_city_state') return 4;
  if (value === 'minnesota') return 3;
  if (value === 'nationwide_united_states') return 2;
  if (value === 'unqualified_role_wide') return 1;
  return 0;
}

function coverageAmbiguous(source: string, vector: AimFactualVector): boolean {
  const evidence = vector.answers
    .filter((answer) => answer.questionId.startsWith('S2.CP.'))
    .flatMap((answer) => answer.evidenceIds)
    .map((id) => evidenceMap(vector).get(id)!)
    .filter((entry) => entry?.source === 'original_jd');
  const expression = /(?:\b(?:salary|pay|compensation|base|ote|on-target earnings|commission|bonus|variable|hourly|equity|stock)\b[^.\n]{0,100}?(?:USD|US\$|\$)\s*\d|(?:USD|US\$|\$)\s*\d[^.\n]{0,100}?\b(?:salary|pay|compensation|base|ote|commission|bonus|variable|hourly)\b)/giu;
  for (const match of source.matchAll(expression)) {
    const start = codePointLength(source.slice(0, match.index!));
    const end = codePointLength(source.slice(0, match.index! + match[0].length));
    if (!evidence.some((entry) => entry.occurrences.some((occurrence) => occurrence.startCodePoint <= start && occurrence.endCodePoint >= end))) return true;
  }
  return false;
}

function conflictingSameType(records: readonly AimCompensationRecord[]): boolean {
  const byType = new Map<string, AimCompensationRecord[]>();
  for (const record of records.filter((entry) => entry.annualizedLowerCents !== null && entry.geographicApplicability !== 'not_deterministically_applicable')) {
    byType.set(record.componentType, [...(byType.get(record.componentType) ?? []), record]);
  }
  return [...byType.values()].some((items) => items.length > 1 && new Set(items.map((item) => `${item.annualizedLowerCents}:${item.annualizedUpperCents}`)).size > 1);
}

export function deriveAimCompensation(
  source: string,
  vector: AimFactualVector,
  metadata: AimTrustedMetadata,
  policy: AimScoringPolicy,
): AimCompensationResult {
  const compensationPolicy = policy.compensation as {
    normalizationVersion: string;
    floorCents: number;
    preferencePointTiers: Array<{ minimumReferenceCents: number; points: number }>;
  };
  const globalCurrency = globallyDeclaredCurrency(vector);
  const globalPeriod = globallyDeclaredPeriod(vector);
  const locationSpecific = isYes(vector, 'S2.CP.Q16');
  const uncapped = isYes(vector, 'S2.CP.Q11');
  const inclusionText = questionEvidence(vector, 'S2.CP.Q17').map((entry) => entry.exactQuote).join('\n').toLocaleLowerCase('en-US');
  const records: AimCompensationRecord[] = [];
  let unsafeParsing = false;

  for (const definition of COMPONENTS) {
    if (!isYes(vector, definition.questionId)) continue;
    for (const evidence of questionEvidence(vector, definition.questionId)) {
      const amounts = parseAmounts(evidence.exactQuote);
      if (amounts === null || amounts.length > 2) {
        unsafeParsing = true;
        continue;
      }
      if (amounts.length === 0) {
        records.push({
          componentType: definition.componentType,
          lowerCents: null, upperCents: null, currency: null, period: null,
          annualizedLowerCents: null, annualizedUpperCents: null,
          geographicApplicability: geographicApplicability(evidence.exactQuote, metadata, locationSpecific),
          cash: definition.cash,
          recurring: definition.recurring,
          treatment: definition.treatment,
          inclusion: definition.inclusion,
          sourceEvidenceIds: [evidence.evidenceId], reasonCode: 'unquantified_component',
        });
        continue;
      }
      const lowerCents = Math.min(...amounts);
      const upperCents = Math.max(...amounts);
      const currency = explicitCurrency(evidence.exactQuote, globalCurrency);
      const period = explicitPeriod(evidence.exactQuote, globalPeriod);
      let cash = definition.cash;
      let inclusion = definition.inclusion;
      if (definition.componentType === 'other_total_compensation') {
        cash = /\b(?:cash|excluding\s+(?:equity|stock|benefits)|does not include\s+(?:equity|stock|benefits))\b/iu.test(evidence.exactQuote);
        inclusion = cash ? 'included' : 'unknown';
      }
      if (definition.componentType === 'draw') {
        inclusion = /\bnon[- ]?recoverable\b/iu.test(evidence.exactQuote) ? 'included' : 'excluded';
      }
      if (inclusionText.includes('exclude') && new RegExp(definition.componentType.replace('_', ' '), 'iu').test(inclusionText)) inclusion = 'excluded';
      records.push({
        componentType: definition.componentType,
        lowerCents,
        upperCents,
        currency,
        period,
        annualizedLowerCents: currency === 'USD' ? annualize(lowerCents, period, evidence.exactQuote) : null,
        annualizedUpperCents: currency === 'USD' ? annualize(upperCents, period, evidence.exactQuote) : null,
        geographicApplicability: geographicApplicability(evidence.exactQuote, metadata, locationSpecific),
        cash,
        recurring: definition.recurring,
        treatment: definition.treatment,
        inclusion,
        sourceEvidenceIds: [evidence.evidenceId],
        reasonCode: currency !== 'USD' ? 'currency_not_explicit_usd' : period === null ? 'period_not_explicit' : 'parsed',
      });
    }
  }

  const highestGeographyRank = Math.max(0, ...records.map((record) => geographyRank(record.geographicApplicability)));
  const applicable = records.filter((record) => geographyRank(record.geographicApplicability) === highestGeographyRank
    && highestGeographyRank > 0);
  const comparable = applicable.filter((record) => record.currency === 'USD' && record.annualizedLowerCents !== null && record.annualizedUpperCents !== null);
  const sourceQuestionIds = vector.answers.filter((answer) => answer.questionId.startsWith('S2.CP.') && answer.answer === 'yes').map((answer) => answer.questionId);
  const sourceEvidenceIds = [...new Set(vector.answers.filter((answer) => answer.questionId.startsWith('S2.CP.')).flatMap((answer) => answer.evidenceIds))];
  const coverageFailure = coverageAmbiguous(source, vector);
  const conflict = conflictingSameType(comparable)
    || comparable.some((record) => record.componentType === 'ote'
      && comparable.some((base) => base.componentType === 'fixed_base' && base.annualizedLowerCents! > record.annualizedUpperCents!));
  const eligibleReferences = comparable.filter((record) => record.cash && record.recurring && record.inclusion === 'included'
    && !['sign_on', 'equity'].includes(record.componentType));
  const referenceValues = eligibleReferences.flatMap((record) => [record.annualizedUpperCents]).filter((value): value is number => value !== null);
  const referenceCashCents = referenceValues.length > 0 ? Math.max(...referenceValues) : null;
  const guaranteedValues = comparable.filter((record) => record.cash && record.recurring && record.inclusion === 'included'
    && ['fixed_base', 'fixed_periodic', 'unlabeled_annual_pay', 'draw'].includes(record.componentType))
    .map((record) => record.annualizedLowerCents).filter((value): value is number => value !== null);
  const provenCashLowerBoundCents = guaranteedValues.length > 0 ? Math.max(...guaranteedValues) : null;

  const explicitTotalUpper = comparable.filter((record) => record.cash && record.recurring && record.inclusion === 'included'
    && ['total_cash', 'other_total_compensation'].includes(record.componentType))
    .map((record) => record.annualizedUpperCents).filter((value): value is number => value !== null);
  const cappedOteUpper = comparable.filter((record) => record.componentType === 'ote'
    && record.sourceEvidenceIds.some((id) => /\b(?:maximum|capped|cap\s+of|not\s+to\s+exceed|cannot\s+exceed)\b/iu.test(
      evidenceMap(vector).get(id)?.exactQuote ?? '',
    )))
    .map((record) => record.annualizedUpperCents).filter((value): value is number => value !== null);
  const exhaustiveText = questionEvidence(vector, 'S2.CP.Q17').map((entry) => entry.exactQuote).join('\n');
  const explicitlyExhaustive = /\b(?:comprise|comprises|composed\s+of|consists?\s+of|constitute|constitutes|make\s+up|makes\s+up)\b.{0,100}\b(?:all|entire|total)\b.{0,60}\b(?:recurring\s+)?cash(?:\s+compensation)?\b|\bno\s+other\s+recurring\s+cash\b/iu.test(exhaustiveText);
  const composableTypes = new Set(['fixed_base', 'fixed_periodic', 'commission', 'variable', 'bonus', 'draw']);
  const composable = comparable.filter((record) => composableTypes.has(record.componentType)
    && record.cash && record.recurring && record.inclusion === 'included');
  const hasFixed = composable.some((record) => ['fixed_base', 'fixed_periodic'].includes(record.componentType));
  const hasVariable = composable.some((record) => ['commission', 'variable', 'bonus', 'draw'].includes(record.componentType));
  const exhaustiveCompositionUpper = explicitlyExhaustive && hasFixed && hasVariable
    ? composable.reduce((sum, record) => sum + record.annualizedUpperCents!, 0)
    : null;
  const upperBoundCandidates = [...explicitTotalUpper, ...cappedOteUpper, exhaustiveCompositionUpper]
    .filter((value): value is number => value !== null);
  const upperBoundTotalCashCents = !uncapped && upperBoundCandidates.length > 0
    ? Math.max(...upperBoundCandidates)
    : null;

  let comparisonState: AimCompensationResult['comparisonState'];
  if (conflict) comparisonState = 'conflicting';
  else if (coverageFailure || unsafeParsing || (records.length > 0 && comparable.length === 0)) comparisonState = 'non_comparable';
  else if (records.length === 0) comparisonState = 'missing';
  else comparisonState = 'comparable';

  const floorOutcome = comparisonState === 'comparable' && upperBoundTotalCashCents !== null
    ? upperBoundTotalCashCents < compensationPolicy.floorCents ? 'below' : 'at_or_above'
    : 'fail_open';
  const compensationReference = [referenceCashCents, provenCashLowerBoundCents].filter((value): value is number => value !== null).sort((a, b) => b - a)[0] ?? null;
  const preferencePoints = comparisonState === 'comparable' && compensationReference !== null
    ? compensationPolicy.preferencePointTiers.find((tier) => compensationReference >= tier.minimumReferenceCents)?.points ?? 0
    : 0;
  const comparableBounds = comparable.flatMap((record) => [record.annualizedLowerCents, record.annualizedUpperCents]).filter((value): value is number => value !== null);
  return {
    normalizationVersion: compensationPolicy.normalizationVersion,
    comparisonState,
    currency: comparable.length > 0 ? 'USD' : null,
    period: comparable.length > 0 && new Set(comparable.map((record) => record.period)).size === 1 ? comparable[0].period : null,
    records,
    normalizedAnnualLowerCents: comparableBounds.length > 0 ? Math.min(...comparableBounds) : null,
    normalizedAnnualUpperCents: comparableBounds.length > 0 ? Math.max(...comparableBounds) : null,
    upperBoundTotalCashCents,
    referenceCashCents,
    provenCashLowerBoundCents,
    floorCents: compensationPolicy.floorCents,
    floorOutcome,
    preferencePoints,
    reasonCode: conflict ? 'conflicting_disclosures' : coverageFailure ? 'coverage_ambiguous' : floorOutcome === 'below' ? 'complete_total_cash_below_floor' : comparisonState,
    sourceQuestionIds,
    sourceEvidenceIds,
  };
}
