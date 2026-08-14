export function aimScoringV2ExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIM_SCORING_V2_EXPORT_ENABLED === 'true';
}

export function experienceScoringV2ExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXPERIENCE_SCORING_V2_EXPORT_ENABLED === 'true';
}

export function scoringV2ExportGateStatus(env: NodeJS.ProcessEnv = process.env) {
  return {
    aim: aimScoringV2ExportEnabled(env),
    experience: experienceScoringV2ExportEnabled(env),
  } as const;
}
