# Repeats of Applied Jobs Reaching the Inbox — Investigation and Fix Design

2026-09-13. Investigation against production (M70 `career_db`). No code or data
has been changed. Analysis scripts are in `scratch/dupe_audit.ts`,
`scratch/dupe_history.ts`, `scratch/dupe_desc.ts`, `scratch/dupe_proto.ts`.

---

## 1. What is happening

Status history starts 2026-08-05. Since then, 1,124 jobs have entered the
Inbox. **60** of them closely resembled a job Joseph had applied to (same
employer, near-identical title). After reading every pair, about **44 are real
repeats** of the same role, ~12 are different jobs, and a few are unclear.

What happened to the 44 real repeats:

- **5 are still in the Inbox right now:** Veeam, Sourcegraph, Safelite, Paycom,
  CoStar.
- Joseph cleared the rest by hand. That meant:
  - passing them as "Already applied"
  - consolidating them through the URL editor (6 times)
  - marking the same role Applied twice (RDO Equipment, Intermedia, SharkNinja,
    ButterflyMX)
  - letting them expire.
- Four more copies are waiting to be scored, and 18 more are parked in Cooldown.
  Cooldown hands them back to the Inbox when it ends (section 5).

The system already has a rule for this: a posting that repeats an Applied job
should be dismissed, with a reason that names the job it repeats. The rule is
correct, but it almost never fires. **In its whole life it has dismissed 6
jobs.**

## 2. Why the existing rule misses

### 2a. It needs employer, title, and location to match character for character (the main cause)

Today a posting counts as a repeat only when its employer, title, and location,
after light cleanup, hash to exactly the same key as the Applied job's. The
same job looks different depending on which site it came from, so the keys
almost never match.

**Employer names differ between sources.** Employer ATS boards use the board's
short name. Aggregators use the company's display name:

| Aggregator copy | Employer-ATS copy |
|---|---|
| Veeam Software | veeamsoftware |
| Sourcegraph | sourcegraph91 |
| Talking Rain | talkingrain.wd1 |
| Redwood Materials | redwoodmaterials |
| RF-SMART | rfsmart |
| Patch My PC | Patchmypc |
| Paycom | Paycom Online |
| Jamf | Jamf Software, LLC |
| Safelite | Safelite Fulfilment |

The cleanup keeps the space in "veeam software" but has no space to keep in
"veeamsoftware", so the two never match. The general duplicate check elsewhere
in the same file already ignores spaces. The Applied-repeat key is stricter
than the rest of the codebase.
(`src/lib/companyIdentity.ts` `companyIdentityKey`;
`src/lib/jobIngestion.ts` `generateV4Fingerprint`, compared with
`isLikelyDuplicatePosting`.)

**Location formats differ between sources:**

| One copy | The other copy |
|---|---|
| Himalayas: "United States" | ATS: "Remote, United States" / "USA - Remote" / "US Remote" |
| Adzuna: "Minneapolis, Hennepin County" | "Minneapolis, MN" |
| CareerForce: "Saint Paul, MN" | "Minneapolis, MN" (same Twin Cities requisition) |

Loosening the key alone would be wrong. The location part of the key is what
stops a Duluth role from being hidden because Joseph applied in Minneapolis.
The data shows real cases it has to keep apart:

- Nidec Key Account Manager: Boston, Lexington TN, and Eden Prairie
- formerra Account Manager: Minnesota vs. Michigan
- Gpac and Georgia-Pacific: dozens of identical territory listings

### 2b. The descriptions are never compared

The general duplicate check accepts a description only if it is exactly
identical. Aggregators truncate descriptions and add footers, so they are never
exactly identical. The Applied-repeat rule doesn't look at descriptions at all.

The descriptions are actually the clearest evidence available. I measured how
much of the shorter description appears word for word in the longer one:

- **Most real repeats:** 0.85–1.00 (41 of the 60 pairs).
- **Different jobs:** 0.00–0.33. Jobgether's six CSM listings ≈0.2, Nidec 0.31,
  Flex vs. Flexential 0.00.
- **Between the two:** a handful of pairs, mostly real repeats where an
  aggregator cut the text. Molex 0.61, Arrow 0.61, Stryker 0.76, U.S. Bank
  0.79, plus one different job (ServiceTitan 0.58).

The groups do not separate perfectly. The 0.80 cutoff proposed below was
chosen because it added no false matches in any test. The cost is missing
those truncated repeats.

### 2c. Revival paths skip the check

Description-recovery requeues moved 229 rows back into the pipeline in the last
30 days (85 of them the Glassdoor "rediscovered after a failed description
fetch" revival), with no repeat check. One of them was the Flexential "Regional Partner Manager" copy. It was
ingested 08-16, before the Applied-repeat rule existed (08-19), and dismissed.
Joseph applied to the LinkedIn copy on 08-25. The revival brought the dismissed
copy back on 09-07, and it is waiting to be scored again. This is the only
exact-key match that got through, and the revival path is why.
(`src/lib/jobIngestion.ts`, `isLegacyHiddenGlassdoorJdFailure` block.)

A broader consequence follows. Once a posting has been seen, every later
sighting of it is recorded as "already known" and ingestion stops before any
repeat check. The Flexential copy was re-seen daily from 09-07 to 09-11 and
never re-checked. **An ingestion-time check therefore only protects a posting
the first time it arrives.** Anything already in the database has to be caught
where it enters the Inbox. (`src/lib/jobIngestion.ts`, the `source_observation`
early return.)

### 2d. Cooldown only hides repeats for 21 days

When Joseph applies, other Inbox jobs at the same employer go to Cooldown for 21
days. That quietly caught many repeats: Suki ×2, Tealium, Bolster, Strategic
Education. But:

- It needs the employer name to match exactly (the same gap as 2a).
- When Cooldown ends, the job gets only the exact company/title/location check
  (deployed 2026-09-07), so a copy from another site goes back to the Inbox.
  (`src/lib/cooldownRecovery.ts` `processCooldownJobs`.)

*Correction, written at deploy time:* this investigation was first written
against a local checkout that did not include the 2026-09-07 commit that added
that exact check to the Inbox door. Production already had it. The findings
still hold, because the exact check is the rule section 2a shows missing
cross-source copies. The 8 live repeats were sitting in production under it.

## 3. Why it got worse lately

Nothing in the matching code broke. The recent commits on this path were
fixes. The number of jobs from overlapping sources went up, and so did
applications:

| Week of | Jobs entering Inbox | …from employer ATS boards | …from Himalayas | Applications |
|---|---|---|---|---|
| 08-03 | 18 | 5 | 0 | 47 |
| 08-10 | 104 | 69 | 11 | 24 |
| 08-17 | 356 | 184 | 68 | 45 |
| 08-24 | 101 | 41 | 28 | 49 |
| 08-31 | 409 | 284 | 74 | 77 |
| 09-07 | 168 | 81 | 17 | 105 |

- The ATS lane moved to the Mac and began covering far more boards. Those rows
  carry board-slug employer names and ATS-style locations.
- Glassdoor, JSearch, and Jobicy all started 2026-08-16. Those rows carry
  display names and "United States".

The same role now routinely arrives twice, in two different formats. Repeats
grow roughly with Inbox volume × applications, and both have climbed.

---

## 4. The fix: a "same role" test used only against jobs Joseph applied to

This test never merges two records. It decides one thing only: whether a
posting should be kept out of the Inbox because it repeats a job Joseph has
applied to, is interviewing for, or passed as "Already applied". The stored
fingerprint and its meaning stay the same.

### 4a. The test

A posting repeats an applied job when all three of these hold:

1. **Same employer.** Spacing, legal suffixes ("Inc", "LLC", "Co"), ATS board
   numbering ("sourcegraph91"), and Workday host tags (".wd5") are ignored.
   If one name is simply the start of the other ("Paycom" / "Paycom Online"),
   that also counts, but only with description proof (rule 4b).
2. **Same title.** "(Remote)", "(REMOTE US)", "– Remote" tags are ignored, and
   "Sr." is read as "Senior". Seniority and specialty still separate jobs:
   Senior Enterprise AM ≠ Enterprise AM, Lead CSM ≠ CSM.
3. **Locations don't contradict each other:**
   - "United States", "Remote", "Anywhere", or no location never contradicts a
     US place.
   - Two places in the Twin Cities metro are the same place.
   - Different states, or two different named cities outside the metro,
     contradict.
   - A foreign location contradicts a US one. This test runs before anything
     else, including the rule that a missing location contradicts nothing, so
     "Buenos Aires, Argentina" does not match "Unknown Location".
   - A multi-location posting matches if any of its locations fits. The whole
     string decides whether a posting is foreign, so "Canada – Remote (ON, AB,
     BC)" isn't split into fragments that look domestic.

…and there is proof:

- **4a. Exact identity:** same employer, title, and location. This rule is
  refused if both descriptions are substantial and clearly different (under
  50% overlap).
- **4b. Description proof:** at least 80% of the shorter description appears
  in the other, and both are at least ~150 words. The size floor stops a stub
  (Rubrik's 75-word aggregator copy) from matching everything.

A Workday "2 Locations" posting that is currently refused as ambiguous is
allowed through when the description proof holds. Graco matched at 0.98.

### 4b. Measured against production

| Test set | Result |
|---|---|
| The 60 historical close-match Inbox arrivals | **39 caught, 0 wrongly caught** (40 in the final build, after the location fixes). Missed real repeats: Stryker (0.76 overlap), Jamf (LinkedIn text totally different), buyersedge (JD rewritten), Rubrik (stub), Esri and Verkada (Adzuna placed a remote role in the search city). |
| Jobs currently live (Inbox, waiting, Cooldown, bookmarked) | 28 matches: 5 Inbox, 4 waiting, 18 Cooldown, 1 bookmarked. Every one reads as a real repeat. (30 in the final build.) |
| Jobs already dismissed, archived, or passed in the last 30 days (a check for false matches) | 79 matches, almost all real repeats Joseph or triage had already cleared. Wrong in the prototype, both fixed by the foreign-first ordering above: Instacart "Canada – Remote (ON, AB, BC…)" vs. "United States"; Darwin AI "Buenos Aires, Argentina" vs. "Unknown Location". Arguable: Amcor "Remote/Home SC; GA; NC" vs. "Remote/Home GA". |

Missed live repeats sitting in Cooldown, because their description overlap is
under 0.80: Molex, Arrow, U.S. Bank.

One judgment call is built in: **the same role at the same employer, where one
posting says remote/national and the other names a city, is treated as a
repeat.** Examples: Airwallex "US – San Francisco" vs. "US – Remote", SeatGeek
"New York" vs. "USA". If Joseph applied to the remote version, the city version
is the same opening to him. Confirm or veto (section 7). In the current live
set, this decides ButterflyMX ("California City, CA" vs. "US Remote"), Oshkosh
("Saint Paul, MN" vs. "United States"), and Veralto ("Minnesota" vs. "United
States").

### 4c. Where the test runs

1. **At the Inbox door (new, the main defense).** Every machine path into the
   Inbox checks for a repeat before it checks Cooldown:
   - scoring import promoting a job
   - Cooldown ending
   - revived jobs finishing scoring

   One check covers repeats whichever copy arrived first, and it closes the
   Cooldown and revival holes. A job Joseph restores or promotes himself is not
   blocked. The same admission function also serves his promote and restore
   buttons, so it must be told who is asking. The repeat check runs only when
   the caller is the machine. (`src/lib/companyCooldown.ts`
   `resolveInboxAdmission` gains an actor argument. Machine callers:
   `scoringImport.ts`, `cooldownRecovery.ts`. User callers that must skip it:
   `src/app/api/jobs/[id]/promote/route.ts`, the restore branch in
   `src/app/api/jobs/[id]/route.ts`.)
2. **When Joseph marks a job Applied, Interviewing, or "Already applied".**
   Copies already in the Inbox or waiting to be scored are dismissed on the
   spot. This is the same moment the current rule uses, with the new test.
   Cooldown copies are left alone and caught at the door when Cooldown ends,
   because Cooldown stays a protected state.
   (`src/lib/appliedDuplicateStore.ts` `suppressLiveAppliedDuplicates`.)
3. **At ingestion, when the description is already in hand.** The new row is
   created already dismissed, with the reason, so no scoring is spent on it. If
   the description isn't available yet, the door catches it later. The existing
   exact-key path is unchanged. This saves scoring cost only; per 2c it never
   sees a posting twice, so it is not the defense.

### 4d. What a dismissed repeat looks like, and how to undo it

- **Dismissed with a reason Joseph can read**, e.g. "Duplicate of a job already
  applied: Senior Global Partner Manager at veeamsoftware — Remote, United
  States". It stays findable under Dismissed.
- **Scores are not touched.** An already-scored job keeps its score and scoring
  state. Only an unscored copy is marked so scoring skips it. **Today's
  dismissal code does the opposite.** It marks every dismissed copy "skipped"
  and clears its scoring error, scored or not. That write has to become
  conditional before the function is reused. Most of the live matches in
  section 5 are already scored. (`src/lib/appliedDuplicateStore.ts`
  `suppressLiveAppliedDuplicates`, the `scoringStatus: 'skipped'` update.)
- **Never dismissed automatically:** any job Joseph has personally acted on
  (bookmarked, restored, promoted, passed, applied) and Manual Imports. The
  bookmarked 3M copy stays put.
- **Pipeline event.** The event records both job IDs and which proof matched
  (identity or description overlap %), so a wrong call can be traced.
- **"Not a repeat" button** on a dismissed repeat. It restores the job and
  remembers that pair so the test never hides it again.
- **Applied card count.** The Applied card shows "2 repeats hidden", linking to
  them.

---

## 5. Current backlog (needs Joseph's approval, section 7)

Once the fix is deployed, these existing jobs would be affected:

| Where | Jobs | What would happen |
|---|---|---|
| Inbox | Veeam (Himalayas), Sourcegraph (Himalayas), Safelite (Himalayas), Paycom (LinkedIn) | Dismissed as repeats (one-time cleanup, previewed first) |
| Waiting to be scored | Omnissa (Himalayas), SPS Commerce (Adzuna), US Foods Twin Cities (SerpApi), Flexential (Glassdoor) | Dismissed as repeats (same cleanup) |
| Cooldown | 18 jobs, including ButterflyMX, Schwan's, Novo Nordisk, Radformation, Veralto, Netrio, OpenSesame, Acxion, Suki ×2, Tealium, Bolster, Oshkosh, Instacart | Untouched now. Dismissed at the door when their Cooldown ends instead of landing in the Inbox. |
| Inbox (Manual Import) | CoStar Sales Associate | Not automatic. See section 6. |
| Bookmarked | 3M IATD BDM | Untouched |

**This sets a deadline:** 399 Cooldown jobs are past their release date and
still parked. Six of the repeats above are among them. Cooldown release only
runs inside the full pipeline run, and that has not released anything since
09-04. Whenever it next runs, all 399 go out at once. If that happens before
the door check ships, the repeats among them land in the Inbox together.

---

## 6. Pasting a link for a job that is already in the Dashboard

### What happens today, and why it's confusing

- **A different link to the same job creates a second card.** The paste check
  only recognizes:
  - the exact same link, or
  - an exact title + company match with the location ignored.

  CoStar is the live example. Joseph applied from careers.costargroup.com on
  09-09 (company "CoStar"). On 09-11 he pasted the Workday link, and that
  created a second card (company "CoStar Realty Information, Inc."). It is
  sitting in the Inbox, staged for tailoring, next to the Applied original.
- **When it does find a match, it changes that card silently.** It marks the
  existing card "staged for tailoring" whatever its status is: applied,
  dismissed, or archived. The message names no card, gives no status, and has
  no way to open it.
- **It can point at a shell.** A link lookup can return a copy that was already
  consolidated into another card, rather than the card that survived. There are
  5 such link collisions in the data now.
- **Merging afterward usually refuses.** Editing a card's URL to fold in a
  duplicate stops whenever title, company, or location are written differently.
  The message is "Review the job details before consolidating. No changes were
  saved.", and there is no way to say "yes, these are the same."

(`src/app/api/jobs/manual-import/route.ts`; `src/components/AdvancedSearchTab.tsx`
line 381; `src/lib/jobUrlReconciliation.ts` `reconcileJobUrlEdit`,
`urlMetadataConflict`.)

### Proposed flow

1. **Paste.** The server checks, in order:
   - Same link or same posting ID. A consolidated copy is followed to the card
     that survived.
   - The same-role test from section 4, run on the title, company, location, and
     description read from the pasted page.
2. **Show the result inline, not in an alert:**

   > **Already in your Dashboard** — *Applied Sep 9*
   > Sales Associate, Apartments.com · CoStar · Minneapolis, MN · from careers.costargroup.com
   > Matched because: same title and employer, descriptions 100% the same.
   > [Open card]  [Add this link to that card]  [Import as a separate job]

   A weaker match says "Looks like the same job" and shows the differences side
   by side: company "CoStar" vs. "CoStar Realty Information, Inc.".
3. **"Add this link to that card"** folds the pasted link into the existing card:
   - The link is recorded as another source for the same job.
   - If the link is the employer's own posting and the card currently opens an
     aggregator, the card's apply link switches to the employer's.
   - Status, scores, résumé, and tailoring stay exactly as they are.
   - No second card is created. If one already exists (like CoStar's), it is
     dismissed with "Consolidated into job …".

   This reuses the existing URL-consolidation machinery (locking, source
   transfer, events). What's new is a user-confirmed override of the
   "title/company/location are written differently" refusal, and nothing else.
   The refusals for two cards holding *different decisions* stay hard. Example:
   one card is Passed, the other Applied, or one has a submitted résumé. Those
   still stop with an explanation and a link to both cards.
4. **Staging for tailoring becomes a button**, not a side effect. It is offered
   only when the matched card is still open (Inbox or waiting).
5. **"Merge with another card"** is added to the card's detail view. It uses the
   same side-by-side confirm, instead of the URL editor's refusal.

---

## 7. Decisions needed from Joseph

1. **One-time cleanup:** dismiss the 8 Inbox and waiting repeats listed in
   section 5 (Veeam, Sourcegraph, Safelite, Paycom, Omnissa, SPS Commerce,
   US Foods, Flexential)? A dry-run list would be shown first. Scores stay.
2. **Remote vs. city:** treat "same role, one posting remote/national, one
   naming a city" as a repeat (the proposed default), or keep those separate?
3. **Paste flow:** stop auto-staging the matched card for tailoring, and make it
   a button?

## 8. Build order

1. **The same-role test, plus fixtures.** Built as a pure function with tests
   from the pairs above:
   - Must match: Veeam, Sourcegraph, Paycom, Safelite, Talking Rain, Graco "2
     Locations".
   - Must not match: Nidec cities, formerra MN/MI, Gpac and Georgia-Pacific
     territories, Jobgether titles, Flex/Flexential, Instacart Canada, UK/Ireland
     copies.

   A dry-run script reports what it would do.
2. **Enforcement.** The Inbox door, the apply-time sweep, and the
   ingestion-time check, each with the protections in 4d. **The door check
   must be live before the next full pipeline run releases the 399 overdue
   Cooldown jobs.** Otherwise Cooldown release has to stay paused until it is.
3. **Screens.** The repeat badge, "Not a repeat", and the hidden-repeat count on
   Applied cards.
4. **Paste-a-link flow and "Merge with another card."**
5. **Cleanup.** The approved backlog cleanup, then a check that no Inbox job
   matches an Applied one.

---

## 9. As built (2026-09-13)

Joseph's answers: hide the 8, remote vs. city counts as a repeat, staging
becomes a button.

- **Cleanup applied to production.** Exactly the 8 rows in section 5 were
  dismissed, each with a recorded reason. Scores are untouched.
- **Combined with the 2026-09-07 exact check.** Automatic paths (score import,
  Cooldown ending) now use the same-role test. Joseph's own promote and
  restore buttons keep the exact-repost block they have had since 09-07, but
  now respect "Not a repeat".
- **Where the check runs.** It runs at the Inbox door (score import and
  Cooldown release), when Joseph marks a job applied, and when a job is first
  saved. The score import reads the applied list once per import, not once
  per job.
- **Hidden repeats list.** An applied card lists the repeats hidden because of
  it.
- **"Not a repeat."** The hidden job's card has a "Not a repeat" button. It
  was tested on the two Aim-scored rows whose Experience scoring had failed
  (in a transaction that was rolled back). Both return to waiting for
  scoring with their Aim score intact.
- **Paste-a-link.** It now shows an inline panel instead of an alert:
  - Same link: "Already in your Dashboard", with the card's status and
    Open card / Stage for tailoring.
  - Same role, different link: Add this link to that card / Open existing
    card / Keep both.
  - It no longer stages tailoring silently.
- **Merge, narrowed from section 6 item 5.** There is no standalone "Merge
  with another card" button yet. A merge is offered when editing a card's URL
  or re-scraping it hits a link that belongs to another card, and from the
  paste panel.
- **Known cost.** The door check runs after scoring, so a repeat still gets
  its Aim and Experience scoring before it is turned away. That is roughly 8
  jobs a week. The expensive parked Cooldown group is checked before it is
  rescored.
