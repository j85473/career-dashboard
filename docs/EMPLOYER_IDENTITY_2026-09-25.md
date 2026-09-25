# One Employer, One Name

2026-09-25. Measured against production (M70 `career_db`). Code:
`src/lib/employerIdentity.ts` (keys, name relation, resolution),
`src/lib/employerLearning.ts` (learning from evidence, keeping cards current),
review tool `scripts/refresh_employers.ts` (dry run by default).

---

## 1. Why the earlier fix did not last

On 2026-09-25, 680 employers appeared under two or more names on cards that
matter (7,230 spellings across 20,186 cards). HP alone appeared as "HP Inc.",
"HP", "hp.wd5", "Hp" and "HP Development Company, L.P.". The sources:

- ATS board slugs stored as the company ("arcticwolf", "spscommerce");
- Workday hostnames used when a posting names no employer ("hp.wd5");
- Workday legal-entity codes ("2100 NVIDIA USA", "ZINC Zillow, Inc.");
- casing and legal suffixes; brand variants only evidence can join
  ("Progleasing" / "Progressive Leasing", "Intapp" / "Integration Appliance").

Every feature that asked "same company?" answered it separately: cooldown,
the company page, the applied-repeat check, the staged-tailoring check and the
display each had their own normalization, two had their own hand-kept alias
lists, and the name rules learned only from manual edits (three rules in
total). Each fix covered one of those paths.

## 2. The model

- `Job.company` stays what the source wrote. It is a scoring input and the
  scoring import rejects a batch whose company changed after export, so
  nothing here rewrites it.
- `Job.employer` is the canonical employer, derived from `company` and the
  posting's employer site on arrival and on every pipeline pass (every five
  minutes). Edits and re-scrapes are picked up by themselves.
- Every "same employer?" question reads `employerIdentityKey` / `sameEmployer`.
  `src/lib/__tests__/employerIdentityContract.test.ts` fails when code outside a
  short, documented list compares employers with an older key.

Consumers switched: company cooldown (admission, parking on apply,
retroactive reconciliation), the company page, the dashboard's company view,
card and detail display, the staged-tailoring check, the applied-repeat check,
the same-job combine, the URL-edit merge check, and the tailoring export.
Scoring export and import keep the raw company.

## 3. How spellings are joined

- Formatting only (case, punctuation, spacing, "The", legal suffixes, entity
  codes, Workday hosts, a slug's board number): one key, no evidence needed.
- A different name is joined only when the names plainly relate (prefix,
  leading brand word, abbreviation, slug) **and** the pipeline has seen proof:
  the same employer site / ATS board, or the same posting (same title, 90%+
  identical text, no location conflict).
- Names that relate only through a two- or three-letter name ("GE" / "GE
  HealthCare") need a site or two separate postings, unless the longer name
  only adds legal-entity filler ("HP" / "HP Development Company, L.P.").
- Evidence without a name relation is refused: identical postings linked
  reposters ("remote nova" / HPE), subsidiaries (Elavon / U.S. Bank) and sister
  brands (Timberland / VF) — ten such pairs in the census.
- Every member of a group must relate to the group's name directly, so links
  cannot chain from one employer to another. A Workday tenant hosting several
  employers (VF, Cigna) names none of them.
- The group's name is the one aggregators use most, then the name most
  spellings contain, then the shorter: "Kraft Heinz", "IQVIA", "Palo Alto
  Networks", "Progressive Leasing".

## 4. Joseph's corrections

- Editing a card's company renames that employer's whole group (the source's
  own spelling, the name the card showed, the new name).
- "Not <employer>?" next to "Listed employer" keeps that spelling a separate
  employer; both names are pinned so no learned link joins them again. Two
  businesses whose names clean up alike ("Flex" / "The Flex Company") are told
  apart by the exact spelling.
- His rules (`origin = manual`) always win. Learned rules (`origin = learned`)
  are recomputed each pass and can be wiped without touching his.

## 5. Measured consequences before release (dry run, 2026-09-25)

- Company pages: 7,230 spellings resolve to 6,187 employers; 760 employers
  gathered from several spellings; 134 visible cards show a cleaner name.
- Cooldown: 7 Inbox cards move to Cooldown because Joseph applied at that
  employer under another spelling (Maven Clinic, Intapp, Scotts Miracle-Gro,
  HP, Arctic Wolf, Nidec, Human Interest).
- Applied repeats: 1 more card hidden (the Scotts Adzuna copy).
- 610 spelling groups, 277 joined by evidence; 12 evidence links refused.

## 6. Verified end to end before release

On a scratch copy of production's schema with the migration applied and the
20,203 cards that matter (dropped afterwards):

- learning produced 1,519 rules; a second pass wrote nothing;
- all 20,187 cards got an employer, no card's last-updated time moved, and a
  second pass changed nothing (names are written with plain SQL because Prisma
  bumps `updatedAt` on every update, and cards show "Applied <date>" from it);
- the "HP" company page gathered 41 cards from all five spellings;
- the combine pass folded 47 cards with every lifecycle check passing and no
  surviving card's last-updated time moving; "Not the same job" restored a copy
  exactly and the next pass left the pair alone.

