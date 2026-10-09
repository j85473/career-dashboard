# ATS posting refresh and saved-data repair

The Language Partnerships Manager job (`42563172-0bde-48fd-bca6-d17030090c7e`)
lost its description structure after a link update because the manual Workday
extractor only accepted `myworkdayjobs.com`. Its `myworkdaysite.com` URL fell
through to JSON-LD, whose SEO description was already flat. The fallback then
saved its extraction-method name as an ATS override.

## Changes

- Compose Workday CXS detail URLs from both public URL families, including
  locale prefixes. Resolve the employer tenant from the shared board parser
  and encode posting path segments once.
- Report the detected ATS from generic JSON-LD extraction. Ignore historical
  `JobPosting JSON-LD` overrides while preserving genuine manual ATS overrides.
- Recover formatted page descriptions only when their text matches the exact
  JSON-LD posting. Exclude navigation and related-job content.
- Read Eightfold's existing public detail API for manual refreshes rather than
  its flat SEO description. Validate the exact requisition and employer domain.
- Preserve heading boundaries in the shared HTML cleaner.
- Add a guarded, dry-run-by-default saved-data repair script. Formatting repair
  retains all historical words, including employer introductions omitted from
  Workday CXS. Apply changes only to unchanged, unleased rows.

## Production data repair

Two guarded transactions repaired 2,768 extraction-method ATS labels across
2,769 jobs. Known providers now use their actual ATS names; listings without
provider evidence have the invalid override removed instead of receiving an
invented ATS. The final verification found zero remaining JSON-LD badges.

The audit inspected 25 flat descriptions. Five were recoverable without
changing their words:

| Job | Provider | ID |
| --- | --- | --- |
| Language Partnerships Manager | Workday | `42563172-0bde-48fd-bca6-d17030090c7e` |
| Training Solutions Sales Manager | Workday | `17071324-39b3-4ce2-93b0-4ba364b6f310` |
| Manager - Partner Success & Membership Care Network Marketing | Workday | `44536609-72c5-4a5b-a8d1-3fd4372554a4` |
| Director, Operations - Drug Product (Biologics) | BioSpace | `530cfc62-732e-4c82-bb4d-fd07c1d78114` |
| Associate Director, Technical Operations - Small Molecule Drug Substance | BioSpace | `e7b3d4ad-f874-4ca3-a225-59aefd44eba6` |

Seventeen older postings no longer returned a description. Three returned
content without a verifiable formatting-only replacement. Their stored
descriptions were retained.

The transactions checked that every Job field except `manualAts`, `description`,
and the edit timestamp was identical before and after. Score and pipeline-event
history was also verified unchanged. Equiti remains in Inbox with Aim 72 and
Experience 84; its repaired description has 75 lines and 49 bullets. The BSI
application remains Applied with Aim 63 and Experience 70.

## Validation and release boundary

- Full suite: 1,942 passed, 7 skipped, zero failures.
- Scoped ESLint and TypeScript checks passed.
- Live patched extraction restored both reported Workday jobs.
- An active Kraft Heinz Eightfold posting returned its exact listing title,
  employer, and a formatted 46-line description through the new adapter.
- Unrelated Zoho Recruit work was preserved and excluded from this commit.

The application patch is committed locally, without push or deployment. The
saved-data corrections are already applied. Until the application patch is
deployed, the old running extractor can create new invalid labels; the final
zero count above is a verification snapshot, not an ongoing guarantee.
