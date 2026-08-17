/**
 * Not every registered ingestion source is a source of jobs.
 *
 * Some are **enrichment sub-sources**: they fire once per posting already
 * discovered by a parent board source, to pull the full description. Workday
 * is the clearest case — `jobIngestion.ts` derives the name as
 * `${boardSource} Details` and calls it per posting, while the resulting job is
 * counted against the parent `ATS-workday`. A detail call therefore never
 * reports a seen or inserted row, by construction.
 *
 * Across all recorded history, zero runs of any `* Details` source have ever
 * reported `seenCount > 0`. Any rule that grades them on yield will call them
 * dead forever: the pipeline's own `zeroYieldRunError` stamped every run "Zero
 * yield: N provider requests completed without returning a parsable row", and
 * the dashboard reported ATS-workday Details as the worst source in the system
 * — while the underlying call was returning a 5,902-character job description
 * on demand.
 *
 * Judge these on whether their requests succeed, never on rows produced.
 */
export function isEnrichmentSubSource(source: string): boolean {
  return /\sdetails$/i.test(source.trim());
}

/**
 * Aggregators that publish only a snippet and never a full job description.
 *
 * Adzuna's API truncates `description` at exactly 500 characters — under the
 * 650-character quality gate — and the URL it supplies is an interstitial
 * rather than the employer's posting, so ordinary JD recovery can never
 * complete. Left alone, every Adzuna job eventually lands in the Action Needed
 * queue asking for a human to fix a description that cannot be fixed by hand;
 * 842 had accumulated there.
 *
 * A listing from one of these is worth discarding rather than queueing for
 * review. The full text is only obtainable by resolving the interstitial in a
 * browser, which `scripts/resolve_adzuna_descriptions.ts` does as an offline
 * batch — that script is the only thing that should rescue these.
 */
const SNIPPET_ONLY_AGGREGATORS = new Set(['adzuna']);

export function isSnippetOnlyAggregator(source: string | null | undefined): boolean {
  return SNIPPET_ONLY_AGGREGATORS.has(String(source || '').trim().toLowerCase());
}
