# The dejobs JSON lookup is case-sensitive and we send lowercase

## Evidence

The `resolve_dejobs_descriptions.ts` run recovered 31 of 98 — and **every one
of the 12 printed samples was extracted by the Workday matcher**. None came
through the new `microsites.dejobs.org` JSON route. That route is not working.

Verified against the live endpoint, three separate ids:

```
404   https://microsites.dejobs.org/ALL_JOBS/df45a9ad1dd44b93828029a551e97c07.json
200   https://microsites.dejobs.org/ALL_JOBS/DF45A9AD1DD44B93828029A551E97C07.json
404 / 200 likewise for 4e8801e2… and 7316ee91…   (~1,185 chars of description each)
```

**The path is case-sensitive and the hex id must be UPPERCASE.**

CareerForce stores the id lowercase — its `sourceId` and stored URL look like
`https://de.jobsyn.org/df45a9ad1dd44b93828029a551e97c078003` — while the dejobs
detail URL that the redirect lands on uses uppercase
(`.../DF45A9AD1DD44B93828029A551E97C07/job/?vs=8003`). So whichever id the code
derives the microsites URL from, if it comes from the stored value it is
lowercase and 404s every time.

Note also the trailing 4 characters: the stored id is **36** chars
(`…c078003`), the JSON key is the first **32** (`…c07`). The `8003` tail is the
`?vs=` site id, not part of the key.

## The change

1. Uppercase the 32-char hex key when building the microsites URL, and slice to
   32 characters explicitly rather than assuming the input length.
2. Add a unit test that feeds a **lowercase 36-char** id and asserts the
   constructed URL is uppercase and 32 chars. That is the whole bug — it must be
   pinned by a test that would have failed before this change.
3. While in there: the JSON carries more than the description —
   `html_description`, `company`, `city`, `state`, `full_address`, `title`,
   `job_category`. Use `company` and the city/state fields to correct the stored
   values when they disagree, in the same spirit as the Rippling `companyName`
   fix. Prefer the plain `description` over `html_description` unless the plain
   one is empty; run whichever is used through `cleanHtmlText`.
4. Keep the self-validating quality check on the fallback branch that caught the
   isolved portal shell. Do not let a 200 response with thin content through on
   status code alone.

## Re-open the rows that were wrongly marked terminal

The last run marked **67** rows terminal at 3 attempts via
`buildTerminalJdRecoveryUpdate`, on the strength of a lookup that never worked.
They are not genuinely unrecoverable.

Extend the script (or add a `--reset-terminal` flag) to find rows it marked
terminal for dejobs/jobsyn URLs and return them to the recovery queue, then
re-run. Identify them by the reason text the script wrote plus a
dejobs/jobsyn URL — do not reset every terminal row in the database.

Report how many of the 67 recover once the case is fixed. Expect most of them:
the three ids tested by hand all returned ~1,185 characters.

## Constraints

- Gates: `npm test` (baseline **626 pass, 0 fail**) and `npm run build`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`** and do not run any `--apply`.
- Prod is a Raspberry Pi sharing this database; writes are live immediately.

## Definition of done

- Uppercase 32-char key, pinned by a test that fails without the fix.
- Company/location corrected from the JSON where they disagree.
- A way to re-open the 67 wrongly-terminal rows, dry run reviewed by Joseph.
- `npm test` ≥626 green, `npm run build` green, commit local and unpushed.
