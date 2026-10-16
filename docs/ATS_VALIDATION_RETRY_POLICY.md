# Career-board validation retries

Discovery candidates remain recorded even when their career page or feed is unavailable.
These rules affect first-collection candidates only; they do not retire established
boards, alter acquisition batches, or change existing jobs, scores or application decisions.

- A first HTTP 404 waits seven days.
- HTTP 410, or another HTTP 404/410 after a previous HTTP 404/410, waits 30 days.
- Other validation failures retain the one-day interval. Provider request pacing and
  intake-capacity/admission guards remain authoritative.
- HireHive's observed `accounts`, `blog` and `storage` service hosts cannot enter new
  discovery. Existing candidates remain recorded, receive a 30-day retry, and make
  no vendor request when the validator encounters them.

The Log panel separates future validation holds from failed candidates whose retry
time has passed (`Validation due`). A time is earliest eligibility, not a scheduled
execution guarantee. Intake capacity and admission policy can delay an eligible check.

## Existing daily retries

Preview the narrow repair with the deployed runtime environment:

```bash
node scripts/with-env.mjs node --import tsx scripts/repair_ats_validation_retry_dates.ts
```

Apply with `--apply --report=/absolute/path/to/a-new-receipt.json`. The receipt must
not already exist. The script locks the admission policy and refuses to run while
a validation lease is live. It selects only discovered candidates with exact stored
HTTP 404/410 errors and a recorded one-day retry within the validator's three-minute
lease. It extends 404 to seven days and 410 to 30 days from the original completion
time. It never shortens longer holds or invents another validation attempt.

The transaction checks every old timestamp/error before updating only the retry
date and update timestamp. Any cohort mismatch rolls back the entire update.
The receipt records every old/new retry date; a second pass should find zero legacy
dates. Candidate identity, state, errors, discovery evidence and validation timestamps
are retained. No schema migration is needed.
