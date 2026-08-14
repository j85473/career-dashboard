export type AimBandCode = 'exceptional' | 'strong' | 'good' | 'mixed' | 'low';

export type AimDisplayBand = {
  code: AimBandCode;
  label: string;
  minimum: number;
  maximum: number;
  fillClass: 'fill-green' | 'fill-blue' | 'fill-amber' | 'fill-red';
  cardClass: 'fit-a' | 'fit-b' | 'fit-c';
};

const AIM_V2_BANDS: readonly AimDisplayBand[] = [
  { code: 'exceptional', label: 'Exceptional Aim fit', minimum: 85, maximum: 100, fillClass: 'fill-green', cardClass: 'fit-a' },
  { code: 'strong', label: 'Strong Aim fit', minimum: 70, maximum: 84, fillClass: 'fill-blue', cardClass: 'fit-a' },
  { code: 'good', label: 'Good Aim fit', minimum: 55, maximum: 69, fillClass: 'fill-amber', cardClass: 'fit-b' },
  { code: 'mixed', label: 'Mixed Aim fit', minimum: 40, maximum: 54, fillClass: 'fill-amber', cardClass: 'fit-b' },
  { code: 'low', label: 'Low Aim fit', minimum: 0, maximum: 39, fillClass: 'fill-red', cardClass: 'fit-c' },
] as const;

export function aimV2DisplayBand(score: number): AimDisplayBand {
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) throw new Error('Aim v2 score must be an integer from zero through 100');
  return AIM_V2_BANDS.find((band) => score >= band.minimum && score <= band.maximum)!;
}

export function aimDisplayFromAssessment(value: unknown, fallbackScore: number | null = null): AimDisplayBand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallbackScore === null ? null : aimV2DisplayBand(fallbackScore);
  }
  const result = value as Record<string, unknown>;
  if (result.variant !== 'scored_survivor') return null;
  const score = Number.isSafeInteger(result.score) ? Number(result.score) : fallbackScore;
  if (score === null) return null;
  const projected = aimV2DisplayBand(score);
  const band = result.band && typeof result.band === 'object' && !Array.isArray(result.band)
    ? result.band as Record<string, unknown>
    : null;
  if (band && (band.code !== projected.code || band.label !== projected.label
    || band.minimum !== projected.minimum || band.maximum !== projected.maximum)) {
    return null;
  }
  return projected;
}

export function aimScoreFillClass(score: number, schemaVersion?: string | null): string {
  if (schemaVersion === 'career-dashboard-aim-result-v2') return aimV2DisplayBand(score).fillClass;
  return score >= 80 ? 'fill-green' : score >= 65 ? 'fill-amber' : 'fill-red';
}
