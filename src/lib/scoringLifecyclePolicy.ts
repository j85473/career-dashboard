export const AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE = 60;

export function aimAdvancesToExperienceQueue(projection: {
  variant: string;
  score: number | null;
}): boolean {
  return projection.variant === 'scored_survivor'
    && projection.score !== null
    && projection.score >= AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE;
}
