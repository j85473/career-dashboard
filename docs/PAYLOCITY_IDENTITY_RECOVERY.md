# Paylocity identity repair — October 28, 2026

Paylocity public detail URLs identify a posting by the numeric final segment of
`/Recruiting/Jobs/Details/{id}`. The shared navigation word `Details` is never a
posting key. Both ingestion and manual URL reconciliation now use one strict
parser. Different numeric identities also block description-based and manual
merges. An incorrect historical source observation cannot suppress a fresh read
of the actual posting, including the public crawler's early known-source check.

## Explicit historical repair

Run `scripts/repair_paylocity_identity.ts` through `scripts/with-env.mjs`.
Every phase requires `--directory <private-report-directory>`.

1. `--preview` writes a hashed plan containing affected cards, original score
   events, original human decisions, exact-link groups, and misassigned source
   observations with their saved board/title evidence.
2. `--apply --selection-hash <hash> --keys` repairs only posting identities.
3. `--apply --selection-hash <hash> --recover` resumes recovery. `--limit N`
   bounds a verification sample. Eight workers overlap database work and public
   employer reads, sharing one request pacer and publisher retry delays.
   Verified employer catalogue metadata passes through the existing local
   admission rules. Eligible postings receive full detail reads and ordinary
   ingestion. Existing application, score and pass states are never reset.
   Every repaired source is reassigned to the verified posting; terminal source
   refusals retain their original observation verbatim in immutable audit
   evidence before the incorrect link is removed. Transient or unverified reads
   remain retryable in `recovery.jsonl`, not falsely completed.
4. `--apply --selection-hash <hash> --consolidate` folds exact-link duplicates
   using the normal protected-card survivor rules and a repair-only policy that
   retains exact displayed scores. Original score events and decision events
   remain attached to their original records. Merge audit evidence includes the
   prior pass reason; attachment and source history moves to the survivor.
5. `--verify` compares all original score and decision events with the preview,
   checks original score fields, descriptions and submitted resumes, and reports
   any remaining source-to-posting identity conflicts.

`plan.json`, `catalogues.jsonl`, and `recovery.jsonl` are durable private repair
artifacts. Keep them with production recovery evidence. Retrying the repair
uses completed per-observation receipts and stable posting keys. Do not replace
an existing preview after writes or erase the original ingestion evidence.
