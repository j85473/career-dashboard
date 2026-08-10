export type TravelOpportunityTier = 'unscored' | 'low' | 'moderate' | 'high' | 'priority';

export function travelOpportunityTier(score: number | null | undefined): TravelOpportunityTier {
  if (score == null) return 'unscored';
  if (score >= 90) return 'priority';
  if (score >= 75) return 'high';
  if (score >= 50) return 'moderate';
  return 'low';
}

export function travelOpportunityFill(score: number | null | undefined): string {
  switch (travelOpportunityTier(score)) {
    case 'priority':
    case 'high':
      return 'fill-green';
    case 'moderate':
      return 'fill-blue';
    case 'low':
      return 'fill-muted';
    case 'unscored':
    default:
      return 'fill-purple';
  }
}
