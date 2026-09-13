/**
 * Durable ownership for an ATS acquisition failure.
 *
 * The watchdog may only shorten a retry that the pipeline imposed on itself.
 * Board-owned outcomes deliberately keep their board/recovery schedule, even
 * when that schedule is longer than the watchdog's deferral horizon.
 */
export const ATS_FAILURE_SCOPES = {
  board: 'board',
  boardControl: 'board_control',
  provider: 'provider',
  providerControl: 'provider_control',
  internalControl: 'internal_control',
} as const;

export type AtsFailureScope = typeof ATS_FAILURE_SCOPES[keyof typeof ATS_FAILURE_SCOPES];

export const ATS_PIPELINE_CONTROL_FAILURE_SCOPES = [
  ATS_FAILURE_SCOPES.internalControl,
  ATS_FAILURE_SCOPES.providerControl,
] as const satisfies readonly AtsFailureScope[];

export function classifyAtsV2FailureScope(input: {
  boardFailure: boolean;
  boardScopedRefusal: boolean;
  rateLimited: boolean;
  requestDispatched: boolean;
}): AtsFailureScope {
  if (input.boardFailure) return ATS_FAILURE_SCOPES.board;
  if (input.boardScopedRefusal) return ATS_FAILURE_SCOPES.boardControl;
  if (input.rateLimited) return ATS_FAILURE_SCOPES.providerControl;
  return input.requestDispatched
    ? ATS_FAILURE_SCOPES.provider
    : ATS_FAILURE_SCOPES.internalControl;
}
