# 712 Minnesota jobs are stuck because dejobs.org stopped serving HTML

## The measurement

Action Needed (live `needs_jd`/`failed`): **1,144**, with **478 created in the
last 24 hours**. By reason:

```
712  JD recovery rejected: no usable role duties.
166  JD recovery rejected: expired, closed, login, cookie
122  JD recovery rejected: fewer than 650 usable characters
```

It is **not** foreign-language noise — only 2 rows are non-English and only 55
were rejectable for free. The ten most recent are all Minnesota:

```
Customer Service                Rochester, MN       de.jobsyn.org/...
Hy-Chi Department Manager       Brooklyn Park, MN   de.jobsyn.org/...
Director of Account Management  Saint Paul, MN      de.jobsyn.org/...
Strategic Account Manager       Eden Prairie, MN    de.jobsyn.org/...
Loan Administrator - CRE        Minneapolis, MN     de.jobsyn.org/...
```

These are exactly the roles the pipeline exists to find.

## Root cause, verified

`de.jobsyn.org/<id>` redirects correctly to `<employer>.dejobs.org/...`, but
that page is now a **client-rendered Nuxt SPA**. Fetched directly it is 2,852
bytes containing `<div id="__nuxt"></div>`, no `<title>`, and
`data-ssr="false"` — **zero characters of server-rendered text**. So every
HTML-based recovery path returns nothing, and the quality gate reports whatever
it can about the emptiness.

CareerForce has no detail page of its own to fall back to (four URL shapes, all
404), and its search card only carries a ~252-character summary.

Their bootstrap config exposes an API:

```js
window.__NUXT__.config={public:{ source:"solr",
  "api-url":"https://prod-search-api.jobsyn.org/api/" }}
```

I could not find the route blind — five guessed paths all 404, and the JS
bundles did not reveal it.

## Task 1 — find the API route before writing a browser scraper

Open a dejobs job page with browser devtools on the Network tab and watch what
XHR the SPA issues to `prod-search-api.jobsyn.org`. That single observation
turns this from a browser-rendering job into a JSON fetch. Try that first; it is
minutes of work and a far better outcome.

## Task 2 — if there is no usable API, render it

`cloakbrowser` is already a dependency and already used by
`src/scripts/careerForceScraper.ts` (via `ApplyRedirectResolver`) and
`scripts/resolve_adzuna_descriptions.ts`. The Adzuna script's `readPostingText`
is the pattern to copy: strip `script/style/noscript/iframe/svg/nav/header/
footer/aside/form` and ARIA navigation roles in the page, prefer a posting
container, fall back to `body` only above 400 chars.

Costs ~7s per posting, so it belongs in a batch script rather than inline
ingestion — same shape as `resolve_adzuna_descriptions.ts`, dry-run by default.

## Task 3 — stop re-fetching what cannot be fetched

Whatever the outcome, a posting whose recovery has failed on a known-dead
extraction path should not be retried indefinitely. Check how
`MAX_JD_RECOVERY_ATTEMPTS` and `AGGREGATOR_SNIPPET_DISCARD_REASON` in
`src/lib/jdRecoveryPolicy.ts` apply here, and make the terminal outcome explicit
rather than leaving 712 rows cycling through Action Needed.

## Constraints

- Note the JD quality gate was corrected in commit `cb719bc` (a substantial
  non-shell description is no longer rejected for missing vocabulary). Stored
  reasons on existing rows predate that and should not be trusted as current
  verdicts — re-assess from the stored description.
- Gates: `npm test` (baseline **609 pass, 0 fail**) and `npm run build`.
- No named functions inside `page.evaluate` — tsx/esbuild `keepNames` injects a
  `__name()` helper that does not exist in the page.
- **Do not `git push`** and do not run any `--apply`.

## Definition of done

- Either a working JSON route, or a batch renderer that recovers a real
  description from a dejobs posting, demonstrated on 5 real rows with their
  first 200 characters printed.
- A terminal outcome for genuinely unrecoverable rows.
- `npm test` ≥609 green, `npm run build` green, commit local and unpushed.
