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
