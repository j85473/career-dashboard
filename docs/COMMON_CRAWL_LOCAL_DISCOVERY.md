# Common Crawl discovery from downloaded index sections

The local source replaces paid Athena searches with direct HTTPS downloads of
compressed CDXJ index blocks. It uses the existing discovery audit, candidate
validation and controlled first-collection admission. It does not download WARC
page content or alter jobs or scores.

## Storage and processing

On M70, use the existing 4 TB HDD mounted at `/media/nas`. Scratch files live only
in its `career-dashboard-commoncrawl` subdirectory. The internal NVMe continues
to hold PostgreSQL. No backup migration, formatting, SSD allocation or additional
drive is required.

The first sizing pass for `CC-MAIN-2026-39-index`, covering all 77 configured ATS
patterns, found a 104,741,069-byte directory and 213 distinct selected compressed
blocks totalling 74,344,821 bytes. These are conservative host intervals; exact
host and path filtering occurs after decompression. Different crawls and future
pattern lists can have different sizes.

The complete latest-crawl transport check validated all 213 selected blocks,
containing 639,000 records; 422,430 records matched at least one configured URL
pattern. These are archived URL captures, not counts of unique boards or live
jobs. The oldest crawl's directory was also scanned, and three selected blocks
were downloaded and validated. Measurements were made on the Mac; a separate
read-only M70 request confirmed HTTP 206 byte-range access. Production processing
speed and full historical coverage have not yet been measured.

- [Latest crawl: complete selected-block verification](evidence/common-crawl-local-latest-2026-10-18.json)
- [Oldest crawl: sizing and three-block sample](evidence/common-crawl-local-oldest-2026-10-18.json)

The worker streams the directory, then downloads, decompresses and searches one
selected block at a time. It pauses at least one second between direct-file
requests. It keeps the directory and at most the current payload/partial payload,
rather than retaining all selected blocks. The maximum directory is 512 MiB,
maximum compressed block is 16 MiB, and maximum expanded block is 128 MiB. A crawl
exceeding a cap fails without earning completion; limits do not truncate results.
At least 20 GiB of free drive space is reserved by default. A missing mount,
symlinked scratch path or insufficient free space stops writes instead of falling
back to the operating-system drive.

## Correctness and restart behavior

1. Resume the existing unfinished audit or create the next audit from missing
   coverage. Preserve its saved pattern identities and existing receipts.
2. Select a required crawl. Skip exact pattern/crawl combinations already
   receipted in that audit.
3. Download its directory with a bounded length check. Treat each sparse directory
   entry as the beginning of an interval. Include the predecessor block when a
   domain begins between entries. Do not grep the directory for domain names.
4. Save the immutable plan, directory SHA-256, selected shard offsets/lengths,
   pattern list and plan hash in PostgreSQL. A restart uses that saved plan; it
   does not need to download the directory again or reinterpret the plan.
5. Fetch each selected block using an exact HTTP byte range. Require HTTP 206,
   matching range and length, valid gzip, valid CDXJ records and correct boundaries.
   Match original URL hosts/paths before extracting board identities.
6. Commit candidates, original source URL/crawl, first-collection waiting inventory,
   statistics and the next-block cursor in one transaction. Exact case-sensitive
   board tokens remain distinct. Duplicate candidates do not increment counters.
7. Delete the compressed block only after that transaction succeeds. A crash
   before commit repeats the block. A crash after commit resumes at the next block
   and cleans up the previously committed file.
8. After all planned blocks commit, save exact pattern/crawl receipts and plan
   completion in one transaction. Only then remove the directory and any remaining
   files belonging to that plan. Continue with the next required crawl.

New patterns added during a partial scan get a separate plan after the saved plan
finishes. Missing matches still require reading their conservative intervals;
transport failures never count as empty results. Existing CDX API offsets,
Athena execution IDs, request tokens and result tokens are not repurposed or
cleared. Checkpoint completion requires every exact required receipt. Candidate
validation and acquisition retain their existing controls.

The new `AtsDiscoveryLocalScan` table owns download progress and provenance.
New candidate source URL/crawl columns are nullable for older records. The
migration only adds fields and a table; it does not rewrite historical data.

## Probe without database changes

Run from the repository with Node 24:

```bash
node --import tsx scripts/probe_common_crawl_local.ts \
  --index CC-MAIN-2026-39-index \
  --workspace /tmp/career-cc-probe \
  --report /tmp/career-cc-probe/measurement.json
```

The probe downloads the directory and validates three selected blocks. Add
`--all-blocks` to validate every selected block. Use `--directory /path/cluster.idx`
to reuse an already downloaded directory. Add `--resume` with `--all-blocks` to
continue a probe whose saved progress has the same immutable plan hash.
The probe never saves board candidates,
starts Athena queries, earns discovery receipts or activates collection. Its
temporary directory and measurement reports are explicitly chosen by the caller.

## Deliberate M70 activation

Committing this change does not select the new source on production. Deploy the
code and additive migration through the normal guarded M70 release workflow.
Then prepare an empty scratch subdirectory owned by `career-dashboard`, with
mode `0700`, on the verified HDD mount. Keep existing backups in place.

Install the supplied `scripts/deployment/m70/common-crawl-local.env.example` as
`/etc/career-dashboard/common-crawl-local.env`, owned by root with mode `0600`.
Both existing discovery services load this file after the older Athena settings,
so `ATS_DISCOVERY_SOURCE=local` takes precedence. The worker does not create an
Athena reader in local mode, even when old AWS settings and saved queries exist.
There is no automatic fallback from local mode to a paid or API search.

Both services retain the existing shared discovery `flock`. Manual production
runs must use that same lock; do not start an independent copy:

```bash
flock -n /var/lib/career-dashboard/data/runtime/discovery.lock \
  node scripts/with-env.mjs npm run ats:discovery:audit
```

Run that command under the service account with the service environment loaded.
The example is a lock-preserving invocation, not a substitute for loading the
root-owned environment files. Both discovery services request reduced CPU and
disk scheduling priority so they cooperate with Dashboard and backup traffic.

`npm run ats:discovery:audit:status` reports each local scan's planned blocks,
completed blocks, compressed byte estimate and status, alongside normal audit
receipts and validation outcomes. The service journal reports committed blocks,
safe cleanup and failures. After activation, independently verify the active
release, migration, actual source selection, increasing saved cursor, durable
candidates/receipts, free space and continued Dashboard health.

## Sources

- [Common Crawl CDXJ index](https://www.commoncrawl.org/cdxj-index)
- [Sparse compressed index format](https://github.com/webrecorder/pywb/wiki/CDX-Index-Format#zipnum-sharded-cdx)
- [Common Crawl direct-download guidance](https://www.commoncrawl.org/get-started)
- [Reference sparse-index reader](https://github.com/webrecorder/pywb/blob/main/pywb/warcserver/index/zipnum.py)
