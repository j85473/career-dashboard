# Gusto collection repair — October 5, 2026

Gusto browser collection was retrying valid postings with multiple “Description”
headings, waiting for a job list on employer account-setup pages, and timing out
while routing empty historical API batches. Stats separately graded the old
`ATS-gusto` collector as though it were still live.

The browser now waits for parsed inventory or exact posting details. Posting
extraction selects the provider's description wrapper and preserves headings
inside the employer-authored text. Matching employer-board UUIDs remain required.
Explicit setup notices with no posting links receive the same weekly recheck as
closed boards. Challenge pages and unrelated HTML cannot become empty successes.
Gusto's soft 404 page becomes an immediate not-found failure with the existing
weekly retry policy.

Historical cleanup retains the existing scalar checks, acquired-data exclusions,
live-work exclusions, parent-row locking, and final safety recheck. Correlated
`NOT EXISTS` probes replace the ORM relation filters that were timing out while
scanning unrelated ledger history. Each candidate window is at most 100 batches;
at most 25 empty batches are routed per invocation. Batch and endpoint receipts
remain stored, and a handoff never counts as a successful API sweep.

Stats retains the old collector's tracked totals under historical collection.
This applies only when its search task is no longer active, browser collection
has recorded a run, and the old collector's last run predates that replacement.
The current `Gusto` browser source retains its own health verdict and errors.
Existing jobs, job provenance, lifecycle state, and scores are not rewritten.

## Verification before deployment

- Full suite: 1,791 passed, one existing skip, zero failures.
- TypeScript, scoped ESLint, production build, and diff checks passed.
- A read-only production query returned 25 eligible historical batches from a
  bounded window in 42 milliseconds. The update plan also uses bounded batch-ID
  access and correlated child-table indexes. No production batches were changed.
- The updated Stats SQL executed successfully against production read-only and
  confirmed the old task is inactive and the replacement task is active.
- A local read-only CloakBrowser run recognized the UHY Advisors and Allianz
  setup notices and read all five MOD BIKES postings, including the service
  manager posting with two “Description” headings. Employer, title, location,
  and full descriptions were recovered. No jobs or task claims were written.

To repeat the browser smoke test:

```sh
node --import tsx scripts/verify_gusto_browser.ts
```

Optional arguments are full public Gusto board URLs. The verifier has no database
imports and uses its own temporary browser profile.

Production activation requires the normal approved GitHub/M70 release. Existing
retry dates are retained; repaired collection applies when each board is next due.
