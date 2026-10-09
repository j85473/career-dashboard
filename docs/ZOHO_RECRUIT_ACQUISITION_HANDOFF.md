# Zoho Recruit public-board acquisition

Zoho Recruit can now supply jobs through the normal ATS acquisition pipeline. The earlier posting extractor handled individual links; this expansion discovers named public career pages, collects their published jobs and lets aggregator matching use known Zoho employer boards.

## Change packet

1. **Entry condition:** Common Crawl or an explicitly supplied vendor-hosted job link identifies a regional Zoho tenant and named career page. Acquisition selects a due board under the existing scheduling, capacity and lease rules. The public page must identify the same catalogue and disclose an employer before its jobs can enter ingestion.
2. **Exit condition:** A successful public feed supplies published postings with a stable board-scoped identity, full description and vendor-hosted link to the existing ledger and consumer. Explicitly unpublished rows supply no new candidate. New candidates still pass prefilter, JD readiness, local triage, Aim and Experience before Inbox admission. A malformed feed produces a source failure rather than an empty success or a job dismissal.
3. **Owner:** Common Crawl and pasted-link discovery own board learning. Existing ATS acquisition owns requests and durable handoff; normal ingestion owns Job persistence. Aggregator matching owns guarded link and description enrichment. No stage ownership moves.
4. **Failure semantics:** Invalid board identity, missing public employer branding, malformed schema and authorization failures remain board-level failures. Genuine rate limits, transport failures and server failures retain the shared provider protections. Matching returns no result for malformed feeds, unpublished postings or ambiguous candidates; these outcomes do not establish that an existing job is closed.
5. **Idempotency and recovery:** The regional hostname and named career page identify the board; numeric posting IDs are scoped to that board. The public endpoint returns one catalogue without offset pagination. Existing ledger receipts, leases and ingestion deduplication retain restart/replay behavior. Matching retains the expected-update-time guard and changes only URL, canonical URL and readable description.
6. **Proof:** Zoho board tests cover regional identity, catalogue and employer verification, feed completion, unpublished rows, malformed responses, ambiguity and guarded enrichment. Discovery tests verify alignment with the schedulable adapter catalogue. Existing acquisition, ledger durability, provider-circuit and stage-order suites cover the shared handoff and lease behavior.

## Existing jobs and release scope

This change needs no schema migration or bulk reconciliation. It does not remove existing jobs when a listing omits them or marks them unpublished. Existing scores and human lifecycle decisions retain their authority. No job repair, registry seed, push or deployment is part of this commit.

The individual Zoho posting extractor was already committed separately. This change adds board discovery, acquisition and employer-link matching around it.

## Validation

- All 183 tests passed across the Zoho posting/board, discovery, direct matching, public ATS, acquisition, acquisition loop, ledger, durability, provider-circuit and stage-order suites.
- TypeScript passed with `tsc --noEmit --incremental false`; ESLint passed for the 15 implementation and test files in this expansion.
- A read-only live check of the thinkbridge Careers page and its public feed confirmed matching board identity and employer branding. The feed supplied 40 raw rows; 35 were published, unique postings with descriptions, and five unpublished rows were excluded. The check did not import jobs or write to production.
- Live evidence establishes this public board's behavior at verification time; it does not establish production deployment or compatibility with every Zoho career-site configuration.
