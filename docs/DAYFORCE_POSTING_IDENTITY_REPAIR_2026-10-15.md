# Dayforce posting identity and historical repair — October 15, 2026

Dayforce posting numbers were treated as globally unique on the shared hosting
domain. Pelican's territory sales opening and Amphenol's engineering opening
both used number 6689. The duplicate matcher accepted that number before checking
the employer or title. This affected ingestion, pasted-link matching and later
source promotion. A confirmed merge could then retain one job's description and
scores while replacing its link with the other employer's posting.

## Prevention implemented

- Posting identity includes the client, career site and posting number. Locale,
  tracking parameters and the two supported Dayforce hosting aliases do not
  change that identity. Malformed Dayforce paths cannot fall through to the
  old shared-host identity.
- Different scoped Dayforce records are rejected before source-ID or
  description-based duplicate checks. Pasted-link matching uses the same parser,
  including valid posting numbers shorter than four digits.
- The source rediscovery check does not suppress fresh work using a bare
  provider number. A source observation attached to a different scoped posting
  can be recovered under a new scoped source key without changing the old
  card, score events or observation.
- Merge review disables confirmation for conflicting Dayforce postings or
  employers. The write path independently enforces that refusal under lock.
- Periodic automatic consolidation also reads both posting URLs and rejects
  conflicting Dayforce records before comparing reprint text, during planning
  and again during the locked write. It cannot bypass the ingestion guard.

## Live data repair

The incident-specific runner in `scripts/repair_dayforce_postings.ts` first
produces a private preview. Apply mode accepts that saved plan and its exact
selection hash, verifies the expected card timestamps and observation owners,
and backs up the original records before writing. Creation receipts, immutable
listing snapshots and substantial description agreement identify earlier bad
source promotions. Existing card descriptions, scores and application decisions
stay with those cards. Reconstructed postings receive their own source metadata
and pass through the normal intake filters without inheriting scores or
applications.

| Operation | Main repair | Follow-up | Total operations |
| --- | ---: | ---: | ---: |
| Existing card identity/link/source repairs | 55,648 | 501 | 56,149 |
| Distinct postings reconstructed | 56,856 | 70 | 56,926 |
| Source observations reassigned | 59,818 | 70 | 59,888 |
| Reconstructed postings admitted to normal scoring | 1,038 | 4 | 1,042 |
| Reconstructed postings retained outside the active queue by intake filters | 55,818 | 66 | 55,884 |

The main repair also undid two incorrect consolidation markers, corrected 18
primary source replacements, restored 29 original discovery sources, and
restored Community Coffee's original link. JCB's Applied card again opens its
own posting. These corrections preserve the existing job content and decisions.

Pelican's card (`3e433be9-965a-4c70-85b5-2752c5995ed7`) now opens
<https://jobs.dayforcehcm.com/en-US/pelican/CANDIDATEPORTAL/jobs/6689>.
The current public Pelican feed independently confirmed that URL and the title
“Territory Sales Representative - Northern Midwest Region.” The card remains
Applied, with application time `2026-10-15T17:20:53.509Z`, local fit 100, Aim 68
and Experience 94. The original Aim and Experience events still have current
authority.

## Verification

- Both apply passes reported zero differences in the protected existing card
  fields: job content, scores and rationales, submitted résumé, tailoring state,
  and the retained or explicitly restored lifecycle state.
- All 58,341 existing score events had the same complete-row fingerprint before
  and after both passes: `908cfbe1225be0489939a2a32c5f2863`.
- The independent audit at `2026-10-15T17:56:16.522Z` examined 118,018 source
  observations across 113,030 owner cards. It found zero mismatched owners, zero
  owner cards containing different Dayforce posting namespaces, and zero invalid
  posting identities. One retained same-posting copy correctly leaves the unique
  identity with its saved sibling; neither record's decision was changed.
- The Dashboard health endpoint reported healthy application/database/schema/
  migration state. A fresh job read confirmed Pelican's link, Applied date,
  scores, and original authoritative score-event IDs.
- Validation: 2,206 tests, 2,196 passed, 10 skipped, zero failures; production
  build, TypeScript and focused ESLint passed.

Private M70 backups and receipts remain under
`/var/tmp/dayforce-repair-20261015-reviewed`,
`/var/tmp/dayforce-repair-20261015-final`, and
`/var/tmp/dayforce-repair-20261015-followup-applied`. The final independent audit
is `/var/tmp/dayforce-repair-20261015-audit.json`. Preview and listing references
remain under the matching incident directories. A partially applied plan must
use a fresh output directory so the original backup cannot be overwritten.

The production data repair is applied. The application prevention changes are
local code changes pending deployment; this repair did not push or deploy an
application release.
