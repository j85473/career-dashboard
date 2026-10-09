# Inbox posting verification repair

## Change packet

1. Entry: the existing daily verifier selects up to 25 oldest-due non-manual, unstaged Inbox jobs whose last attempt is older than one day, with no JD/local claim and no active scoring state. It reads the saved posting, source, company, title, location and description; no scoring stage or lease is claimed.
2. Exit: affirmative posting evidence keeps the card in Inbox. Confirmed closure expires only the unchanged card. A dead aggregator link with a uniquely matched, verified live employer posting repairs the apply/canonical links and keeps Inbox. Blocked, ambiguous, empty, generic or failed requests remain inconclusive and keep Inbox. Scores and scoring states retain authority.
3. Owner: the existing Inbox verifier owns liveness and guarded link repair. The existing direct employer matcher owns identity resolution. No new background worker is introduced.
4. Failure: 403, 429, transport failures and application shells are operational uncertainty, never closure. Explicit closure, missing-posting responses and a confirmed WWR posting-to-home redirect are source unavailability. Reader failures cannot confirm target closure.
5. Recovery: every result advances the existing daily attempt clock. Conditional writes include original URL, updatedAt, Inbox and unstaged state. Repeat execution uses the repaired link. Persist an immutable verification event with outcome and probes; user changes defeat the stale write. No production reconciliation is run by this repair.
6. Proof: focused fixtures cover Jobilize's inserted title/location expiry notice, JobLeads reader target-404, hydrated Workday closure, WWR homepage redirection, blocked/live shells, canonical recovery, scores, races and exact-description disambiguation of Datadog's two requisitions.

## Current evidence

The committed matcher returns no match for the supplied Datadog card and 633 stored employer postings. Both same-title postings fail the worldwide location comparison. After normalizing WWR's publisher wrapper, the saved full body agrees with requisition 7582679 and its $138,000-$184,000 range; the other stored requisition quotes $138,000-$202,000. Both requisitions currently appear on the employer board, so title alone is insufficient.

The existing verifier marks any nonempty successful response alive. Jobilize instead serves an expired notice surrounded by replacement jobs, JobLeads blocks direct requests but the existing safe reader reports the requested target as missing, and Workday requires rendering past its redirect/cookie shell to see its missing-page notice.

The repair remains local until explicitly deployed. Existing rows are revisited through the normal daily verification clock after deployment, without a bulk reset or score changes.

## Validation

- All 141 focused tests passed, covering employer matching, posting verification, pipeline contracts, provider controls, manual-import protection and external-fetch safety. TypeScript and lint passed; patch integrity is clean.
- Read-only M70 probes loaded the new posting checker in memory, with no file or database changes. The supplied Acosta/Jobilize, Essor/JobLeads and Epicor/Workday links each classified expired. The WWR link classified expired as a posting-to-search redirect; Datadog's employer posting 7582679 classified alive.
- Replayed the actual Datadog card against all 633 saved ATS postings. The prior matcher returned no match; the repaired matcher selects 7582679 using substantial-description evidence and refuses empty, conflicting or ambiguous bodies.
- Existing score fields, descriptions, scoring states and leases remain intact. Live data was only read; no Inbox repair, reconciliation or deployment has been applied.
