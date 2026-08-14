/**
 * Read-only Aim v1 policy retained solely to validate historical v1 artifacts.
 * New Aim work must use aimResultBuilder.ts and aim-policy-v2.json.
 */
export const HISTORICAL_AIM_V1_HARD_STOP_CODES = [
  'inside_sales',
  'personal_hunting_over_one_third',
  'non_minneapolis_base_required',
  'part_time_temporary_contract_or_1099',
  'consumer_store_sales',
  'religious_employer',
  'direct_pepsico_employer',
  'direct_att_employer',
  'local_insurance_agency',
  'total_comp_below_60000',
] as const;

export type HistoricalAimV1HardStopCode = typeof HISTORICAL_AIM_V1_HARD_STOP_CODES[number];
export type HistoricalAimV1HardStopState = 'present' | 'absent' | 'unclear';

export const HISTORICAL_AIM_V1_RUBRIC_POINTS = {
  coreWork: { exceptional_archetype: 40, strong_fit: 34, acceptable_fit: 26, weaker_but_eligible: 16, unclear: 26 },
  buildingAutonomy: { ground_floor_or_major_ownership: 25, strong_ownership_or_growth: 19, some_influence: 12, little_building_or_autonomy: 5, unclear: 12 },
  productIndustry: { highly_fascinating: 20, interesting_technology: 14, slight_positive: 6, neutral_or_unclear: 0 },
  travel: { international: 15, national_air: 12, overnight_regional: 8, local_territory: 4, mode_unspecified: 4, none_or_unstated: 0 },
} as const;

export type HistoricalAimV1RubricBands = {
  -readonly [Category in keyof typeof HISTORICAL_AIM_V1_RUBRIC_POINTS]: keyof typeof HISTORICAL_AIM_V1_RUBRIC_POINTS[Category];
};

export function deriveHistoricalAimV1Decision(input: {
  hardStops: Readonly<Record<HistoricalAimV1HardStopCode, HistoricalAimV1HardStopState>>;
  rubric: HistoricalAimV1RubricBands | null;
}): { decision: 'survivor' | 'rejected_hard_stop'; aimFitScore: number | null; hardStopCodes: HistoricalAimV1HardStopCode[] } {
  const hardStopCodes = HISTORICAL_AIM_V1_HARD_STOP_CODES.filter((code) => input.hardStops[code] === 'present');
  if (hardStopCodes.length > 0) {
    if (input.rubric !== null) throw new Error('historical hard-stop rejection must not carry rubric bands');
    return { decision: 'rejected_hard_stop', aimFitScore: null, hardStopCodes };
  }
  if (!input.rubric) throw new Error('historical Aim survivor must carry all rubric bands');
  const aimFitScore = (Object.keys(HISTORICAL_AIM_V1_RUBRIC_POINTS) as Array<keyof typeof HISTORICAL_AIM_V1_RUBRIC_POINTS>)
    .reduce((sum, category) => sum + Number(HISTORICAL_AIM_V1_RUBRIC_POINTS[category][input.rubric![category] as never]), 0);
  return { decision: 'survivor', aimFitScore, hardStopCodes: [] };
}
