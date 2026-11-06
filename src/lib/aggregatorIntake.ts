import { findStoredAtsPostings, resolveDirectAtsPostingFromCatalogue, selectDirectAtsMatch,
  type BoardIdentity, type BoardPosting, type DirectAtsMatch, type DirectMatchDeps, type DirectMatchJob } from './atsDirectMatch';

export type AggregatorIntakeDecision =
  | { kind: 'matched'; match: DirectAtsMatch }
  | { kind: 'unknown_board' }
  | { kind: 'expired'; reason: 'absent_from_complete_employer_catalogue'; boards: BoardIdentity[] }
  | { kind: 'pending'; reason: string };

/** Known employer boards are an admission check, not optional enrichment. */
export async function assessAggregatorIntake(job: DirectMatchJob, deps: DirectMatchDeps): Promise<AggregatorIntakeDecision> {
  try {
    const catalogue = await findStoredAtsPostings(job.company, deps.store, [job], { includeRetiredBoards: true });
    let outcome: string = 'lookup_inconclusive';
    let completed: { boards: BoardIdentity[]; postings: BoardPosting[] } | undefined;
    const match = await resolveDirectAtsPostingFromCatalogue(job, catalogue, {
      ...deps, allowLivePing: true,
      onOutcome: value => { outcome = value; deps.onOutcome?.(value); },
      onLiveCatalogue: evidence => { completed = evidence; deps.onLiveCatalogue?.(evidence); },
    });
    if (match) return { kind: 'matched', match };
    if (outcome === 'no_verified_board') return catalogue.unavailableBoards?.length
      ? { kind: 'pending', reason: 'employer_board_excluded' } : { kind: 'unknown_board' };
    // One or several plausible live requisitions means ambiguity, not expiry.
    // A failed/unsupported/partial read never reaches onLiveCatalogue.
    if (completed && !catalogue.unavailableBoards?.length
      && !completed.postings.some(posting => selectDirectAtsMatch(job, [posting]))) {
      return { kind: 'expired', reason: 'absent_from_complete_employer_catalogue', boards: completed.boards };
    }
    return { kind: 'pending', reason: outcome };
  } catch {
    return { kind: 'pending', reason: 'employer_lookup_failed' };
  }
}
