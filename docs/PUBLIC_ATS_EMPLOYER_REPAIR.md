# Oracle and UKG employer repair

New Oracle and UKG handoffs to card creation require a source-backed
company name. Older downloaded work with missing employer evidence retains its
unprocessed suffix through the existing soft-interruption path.
Oracle's own branded tenant can identify Oracle even when LegalEmployer is
empty. Customer tenants keep their own employer; the Intercorp tenant's explicit
first-person equality statement names the legal hiring entity rather than its
parent. UKG uses the exact board's legacy logo or modern React header. Internal brand
and template labels are rejected; the legacy logo's own corporate link can
supply the same website fallback as a modern header. The adapter reads
explicit metadata on the employer website that header links. A corroborated
first-person introduction can identify a hiring subsidiary.

Retained handoffs wait one hour for missing employer evidence without increasing
their failure count, blacklisting the board, or opening a shared provider circuit. Real provider rate
limits and transport controls retain their existing protection.

## Acquisition handoff

New Oracle and UKG detail work uses the same exact-posting evidence reader as
retained handoffs. The reader checks the posting ID, title and board, then uses
published posting or board evidence to resolve the employer. Oracle's already
downloaded detail response and the listing's already fetched board page are
reused; a source lookup does not need to download them again.

An unresolved employer stays pending in acquisition with an item retry one hour
later. It does not receive a terminal enrichment marker or enter the card
consumer's employer-retry queue. Provider retry dates and operator stops take
precedence. Secondary requests share one network deadline, pass through provider
controls, and run after the previous request releases its provider fence.
Complete segments can proceed independently; a segment containing a pending
item still waits for that item under the existing immutable manifest rules.

Ready handoffs need no further employer lookup during card creation. Older
immutable handoffs retain their board-then-posting recovery path through the
same evidence reader. Recovery fills the consumer's local copy only. Installing
this change does not rewrite saved markers, manifests, retry dates, existing
cards, scores, or lifecycle decisions, and does not bulk-release retained holds.

## Historical repair

Run under the normal production runtime environment:

```sh
node --import tsx scripts/repair_public_ats_employers.ts --plan /var/lib/career-dashboard/data/runtime/public-ats-employer-repair.json
node --import tsx scripts/repair_public_ats_employers.ts --plan /var/lib/career-dashboard/data/runtime/public-ats-employer-repair.json --apply
```

Collection is read-only and resumes from a checkpoint. `--retry-unresolved`
rechecks previously unverified rows. `--candidates FILE` accepts an exported
object with an `unknown` array for a database-free collection pass. Four bounded
public requests run at once. A 429 stops the pass without immediate retries.
Evidence bodies and their SHA-256 hashes are retained alongside the plan.
A missing Oracle label can use a verified posting with the same LegalEmployerId
on the same tenant; both exact posting records remain in the evidence.
`--link-evidence` performs this verification on an existing plan without network
or database access. A numeric legal-entity ID alone never supplies a name.

Review the names and evidence before applying. Apply re-parses the preserved
source evidence and checks its hashes before writing. Each transaction checks
that the job's name, title, source identity and URL still match the inspection,
and skips active native/manual scoring and staged tailoring work. A concurrent
change also skips the row. The receipt records each outcome; repeat application
is idempotent.

Only company, employer and their non-unique identity fingerprint change. Existing
scores, score authority, status, descriptions, posting identity, source downloads,
manual batches and application history stay intact. Each correction appends an
auditable pipeline event. Agreed board names are stored as `ats_board_employer`
source evidence, supplying missing labels to already-downloaded work; they are
not global aliases and do not override a supplied company name. An Oracle
customer's posting-level legal employer is never promoted to a board-wide name.
Closed or unbranded postings remain unresolved rather than receiving a guess.
