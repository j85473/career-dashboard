# One Job, Two Cards — Automatic Combining Across Sources

2026-09-25. Measured against production (M70 `career_db`). Code:
`src/lib/sameJobMatch.ts` (the test) and `src/lib/sameJobConsolidation.ts`
(who survives, folding, undo). Review tool: `scripts/consolidate_same_jobs.ts`.

---

## 1. Why duplicates kept appearing

Ingestion drops an incoming posting only when it is provably the same record:
the same requisition URL, the same source ID, or a byte-identical description
under an identically normalized employer, title and location. Aggregators
defeat every one of those, and nothing looked again after a card was saved.
On 2026-09-25 the visible pairs differed only in presentation:

- **Employer:** `chrobinson.wd5` / "C.H. Robinson", "ZINC Zillow, Inc." /
  "Zillow Group", "Progleasing" / "Progressive Leasing", "U.S. Bank" /
  "Elavon, Inc." on the same requisition P-040289.
- **Location:** "Remote - US" / "United States", "Eden Prairie, MN" /
  "Eden Prairie, MN United States of America".
- **Description:** the same text with other line breaks, a publisher footer,
  or a few changed characters (lengths within 1–3%).

Joseph was merging these by hand; he merged the LG Electronics pair during
the investigation.

## 2. What identifies the same job (measured)

Census of 2,382 visible or decided cards, 3,895 candidate pairs:

| Signal | True copies | Different jobs |
| --- | --- | --- |
| Share of the shorter description's five-word runs found in the other | 0.80–1.00, almost all ≥ 0.95 | 0.50–0.75 for sibling requisitions (Samsara, Affirm, C.H. Robinson) |
| Title after presentation cleanup | equal | often one word apart (Esri "- AWS" / "- System Integrators" share 97% of text) |
| Location | never contradicts | territory clones share 95–100% of text (EquipmentShare Minneapolis / Sioux City) |
| Employer name | unreliable (subsidiaries, reposters, ATS slugs) | — |

So: **title decides whether two cards can be one job, location must not
contradict, and text proves it.** Without usable text on one side, only an
exact employer, title and specific-place match counts (keeps Home Depot's
store-by-store postings apart). Two postings from the same employer feed (two
ATS rows, or two DEjobs/CareerForce rows) are never paired: the employer
listed them separately.

Location for combining is stricter than for applied repeats: two different
specific places never match, even within the Twin Cities metro (Acosta
Shakopee / Maple Grove are separate territories; Adzuna's "Bloomington,
McLean County" is Illinois). Workday's "All Cities, Minnesota" reads as
statewide. JD-recovery error pages (CloudFront 403) are treated as no text.

## 3. Who keeps the job

- A card Joseph acted on — applied, interviewing, bookmarked, passed, staged
  tailoring, submitted résumé, his own lifecycle click, a Manual Import — is
  never folded and always survives over machine-placed copies. Two of his own
  cards are never combined with each other.
- A pass marked **Expired** (the copy's link was dead) and the old automated
  pass reasons do not absorb a live copy.
- Among machine-placed cards: more scores, then Cooldown over Inbox over
  waiting-for-scoring (Cooldown means Joseph applied at that employer
  recently), then the employer's own posting, then the older card.
- A copy that could belong to more than one card (HP's four "Account
  Executive" requisitions) is left alone.

Scores are never averaged, carried or cleared. The folded card keeps its
description, scores and history; it is dismissed with the consolidated reason
every duplicate reader already skips, and its sources move to the survivor.
When the survivor came from an aggregator, it takes the employer's link.

## 4. When it runs

Every five minutes in the pipeline (its own loop, not the ingestion
housekeeping, which only runs after a full provider cycle), and right after a
scoring import commits so a newly admitted copy never sits in the Inbox.
Cards held by a scoring, JD or context export wait for the next pass.

## 5. Undo

Each card lists the copies combined into it. "Not the same job" restores the
copy exactly as it was before the fold (status, scoring state, source, and any
link the survivor took), records it as Joseph's decision, and remembers the
pair so it is never combined again.

## 6. Verification

- Unit tests: `src/lib/__tests__/sameJobMatch.test.ts`,
  `src/lib/__tests__/sameJobConsolidation.test.ts`, built from the census pairs.
- Every planned fold and its undo was executed against production rows inside
  transactions that were rolled back: 48/48 passed the lifecycle invariants.
- Dry run on 2026-09-25 before release: 48 cards would be combined, 1 group
  left alone as ambiguous (HP).
