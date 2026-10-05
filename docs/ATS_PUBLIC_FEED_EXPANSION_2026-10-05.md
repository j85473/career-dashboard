# Public ATS feed expansion

Teamtailor now follows the public JSON Feed continuation through every page. The
continuation flag is saved with each listing response, so a worker restart drains
the saved response before asking for the next page. An explicit final page ends
the sweep even when it contains exactly 100 jobs. Feed-supplied URLs are validated
against the requested board; subsequent requests are reconstructed locally.

Dayforce, Oracle Cloud, UKG/UltiPro, Comeet, and SAP SuccessFactors are connected to
Common Crawl discovery, pasted-link board discovery, acquisition, durable job
identity, enrichment, and import mapping. New Common Crawl patterns start with
recent indexes and still require receipts for every historical index. Existing
audit checkpoints and completed work remain intact.

## Live verification

The read-only adapter verifier completed these whole-board reads on October 5,
2026. Counts describe provider listings, not imported or suitable jobs.

| Provider | Verified employer | Listing records | Distinct posting views | Pages |
| --- | --- | ---: | ---: | ---: |
| Teamtailor | Morris Group Site | 242 | 242 | 3 |
| Dayforce | Dayforce | 432 | 308 | 1 |
| Oracle Cloud | Resideo | 68 | 68 | 3 |
| UKG/UltiPro | Dreyer's Grand Ice Cream | 56 | 56 | 3 |
| Comeet | Port | 27 | 27 | 1 |
| SuccessFactors | DeLaval | 8 | 8 | 1 |

Oracle and UKG inventory summaries are not descriptions. The enrichment worker
retrieves exact requisition/opportunity details for titles that survive the
existing title gate. Sample recovered descriptions contained 7,533 and 11,109
characters respectively, with the actual employer and work locations preserved.
Dayforce, Comeet, and SuccessFactors provide full descriptions in their feeds.

Dayforce repeats requisitions across career sites and locales, including duplicate
records for the same public URL. Its durable identity includes the public posting
path so distinct views survive; the existing occurrence/compaction ledger handles
repeated identical views without discarding the source observations.

## Provider-specific requirements

- Comeet's read token comes from the matching public career page configuration.
  It is cached only in the fetching process. Saved job envelopes and receipts do
  not contain the token, configuration objects, or token-bearing API URLs.
- Oracle identities retain the host and career-site number. UKG identities retain
  the recruiting host, employer tenant and board UUID. Posting IDs are scoped to
  those identities to prevent collisions between unrelated employers.
- SuccessFactors identities retain the regional host, exact company ID and
  explicit locale (or the provider's default). The XML parser requires a
  `Job-Listing` root even when SAP serves it as `application/octet-stream`.
- SuccessFactors feeds often omit the employer. Discovery defers those boards
  until employer branding is verified. Generic "Career Opportunities" titles and
  opaque company IDs never become company names. DeLaval's exact tenant has a
  binding to its employer-branded header; the binding requires that branding to
  remain present. Other boards can supply employer authority through structured
  public metadata or an explicit `CompanyName` feed field.
- Employers can disable or restrict public feeds. A discovery validation failure
  stays retryable and does not create a permanently retired board.

## Release and activation

All changes are prospective. They do not rewrite existing jobs, remove scores,
reopen completed ingestion batches, or reset historical audit receipts. No
database schema change is required.

After an approved normal GitHub/M70 release:

1. Run `node --import tsx scripts/seed_public_ats_boards.ts` on the active release
   for live validation only.
2. Run that command with `--apply` to add the five verified launch boards. Existing
   boards retain their schedule/status; permanent retirement tombstones remain
   authoritative. New boards receive their normal rotation cohort and become due.
3. Run the existing Common Crawl audit through its managed service. It discovers
   the new patterns without resetting old receipts. Normal acquisition and
   consumption process eligible new boards under existing pacing/backpressure.
4. Verify provider request/contact receipts, listing completion, enrichment and
   import outcomes. Teamtailor's next normal sweep uses the fixed paginator;
   previously completed first-page sweeps are not replayed automatically.

For a database-free live smoke test, run
`node --import tsx scripts/verify_public_ats_adapters.ts --output=/tmp/ats-public-feed-receipt.json`.
The optional receipt contains counts and sample metadata only.

Provider references:
[Dayforce public job feeds](https://help.dayforce.com/r/documents/Dayforce-Web-Services-Introduction-Guide/RESTful-Get-Job-Feeds),
[Oracle career-site requisition endpoint](https://docs.oracle.com/en/cloud/saas/human-resources/farws/op-recruitingcejobrequisitions-get.html),
[Comeet published positions](https://developers.comeet.com/reference/careers-api-list-all-positions),
[SAP XML listing and locale behavior](https://userapps.support.sap.com/sap/support/knowledge/E/2428902),
[Common Crawl index queries](https://index.commoncrawl.org/).
