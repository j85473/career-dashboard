import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { buildRuntimeDatabaseUrl } from '../src/lib/databaseUrl';
import { recruiteePostingIdentity, recruiteePostingLocation, isRecruiteeWorkModeOnlyLocation } from '../src/lib/recruiteeLocation';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';

// This repair intentionally bypasses ingestion and scoring. Only Job.location
// is written: even updatedAt, identity hints, lifecycle, and old score bindings
// remain intact. Correcting published metadata never authorizes a rescore.
const VERSION = 'recruitee-location-only-recovery-v1';
const RELATED_TABLES = ['JobScoreEvent', 'JobScoringArtifact', 'AimFactualExtraction',
  'JobStatusHistory', 'JobScoringStatusHistory', 'JobPipelineEvent', 'ScoringBatchItem'] as const;
type Candidate = {
  id: string; company: string; title: string; url: string | null; sourceId: string; source?: string;
  location: string | null; status: string; scoringStatus: string;
  fitScore: number | null; aimFitScore: number | null; reqFitScore: number | null;
};
type Resolved = { candidate: Candidate; location: string; responseUrl: string; catalogueSha256: string };
type PlanPayload = { version: string; createdAt: string; candidates: number; resolved: Resolved[];
  unavailable: { candidate: Candidate; reason: string }[] };
type Plan = PlanPayload & { selectionHash: string };
type JobRow = Record<string, unknown> & { id: string; location: string | null; url: string | null; source: string; sourceId: string };

const missingLocation = isRecruiteeWorkModeOnlyLocation;

async function save(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

type PublishedOffer = { id: string; title: string; url: string; location: string };
const catalogueCache = new Map<string, Promise<{ offers: PublishedOffer[]; sha256: string }>>();
function catalogue(tenant: string) {
  const endpoint = `https://${tenant}.recruitee.com/api/offers`;
  let cached = catalogueCache.get(tenant);
  if (!cached) {
    cached = (async () => {
      const response = await safeExternalFetch(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`http_${response.status}`);
      if (response.url !== endpoint) throw new Error('catalogue_redirect');
      const body = await response.text();
      const data = JSON.parse(body) as { offers?: unknown };
      if (!Array.isArray(data.offers)) throw new Error('invalid_catalogue');
      const offers = data.offers.flatMap((value: unknown): PublishedOffer[] => {
        if (!value || typeof value !== 'object') return [];
        const offer = value as Record<string, unknown>;
        if (!['number', 'string'].includes(typeof offer.id) || typeof offer.title !== 'string' || typeof offer.careers_url !== 'string') return [];
        return [{ id: String(offer.id), title: offer.title, url: offer.careers_url, location: recruiteePostingLocation(offer) }];
      });
      return { offers, sha256: createHash('sha256').update(body).digest('hex') };
    })();
    catalogueCache.set(tenant, cached);
  }
  return cached;
}
const normalizedTitle = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
async function resolve(candidate: Candidate): Promise<Resolved | { candidate: Candidate; reason: string }> {
  const identity = candidate.url ? recruiteePostingIdentity(candidate.url) : null;
  if (!identity) return { candidate, reason: 'invalid_posting_url' };
  try {
    const feed = await catalogue(identity.tenant);
    const matches = feed.offers.filter(offer => offer.id === candidate.sourceId
      && recruiteePostingIdentity(offer.url)?.url === identity.url && normalizedTitle(offer.title) === normalizedTitle(candidate.title));
    if (matches.length !== 1) return { candidate, reason: 'no_unique_exact_posting_match' };
    const posting = matches[0];
    if (!posting.location || isRecruiteeWorkModeOnlyLocation(posting.location)) return { candidate, reason: 'no_published_geography' };
    return { candidate, location: posting.location, responseUrl: posting.url, catalogueSha256: feed.sha256 };
  } catch (error) {
    return { candidate, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function preview(client: Client, file: string): Promise<void> {
  const { rows: candidates } = await client.query<Candidate>(`
    SELECT id, company, title, url, source, "sourceId", location, status, "scoringStatus",
      "fitScore", "aimFitScore", "reqFitScore"
    FROM "Job" WHERE source = 'ATS-recruitee'
      AND lower(btrim(location)) IN ('remote', 'remote job', 'hybrid', 'hybrid job', 'on-site', 'on-site job')
    ORDER BY id
  `);
  const resolved: Resolved[] = [], unavailable: PlanPayload['unavailable'] = [];
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const results = await Promise.all(candidates.slice(offset, offset + 4).map(resolve));
    for (const result of results) {
      if ('location' in result) resolved.push(result);
      else unavailable.push(result);
    }
    console.log(JSON.stringify({ processed: Math.min(offset + 4, candidates.length), total: candidates.length,
      recovered: resolved.length, unavailable: unavailable.length }));
  }
  const payload: PlanPayload = { version: VERSION, createdAt: new Date().toISOString(), candidates: candidates.length, resolved, unavailable };
  const plan: Plan = { ...payload, selectionHash: canonicalJsonSha256(payload) };
  await save(file, plan);
  console.log(JSON.stringify({ mode: 'preview', file, candidates: candidates.length, recovered: resolved.length,
    unavailable: unavailable.length, selectionHash: plan.selectionHash }));
}

async function relatedDigests(client: Client, ids: string[]): Promise<Record<string, unknown>> {
  const digests: Record<string, unknown> = {};
  for (const table of RELATED_TABLES) {
    // Table names come exclusively from the fixed allowlist above.
    const { rows: [result] } = await client.query(`
      SELECT count(*)::int AS count,
        md5(coalesce(string_agg(md5(to_jsonb(r)::text), '' ORDER BY r.id), '')) AS digest
      FROM "${table}" r WHERE "jobId" = ANY($1::text[])
    `, [ids]);
    digests[table] = result;
  }
  return digests;
}

async function apply(client: Client, file: string, approvedHash: string, receiptFile: string): Promise<void> {
  const plan = JSON.parse(await readFile(file, 'utf8')) as Plan;
  const { selectionHash, ...payload } = plan;
  assert.equal(plan.version, VERSION, 'Wrong recovery plan version');
  assert.equal(selectionHash, approvedHash, 'Selection hash differs from the reviewed plan');
  assert.equal(canonicalJsonSha256(payload), selectionHash, 'Recovery plan content changed');
  assert.equal(new Set(plan.resolved.map(r => r.candidate.id)).size, plan.resolved.length, 'Duplicate plan IDs');
  for (const record of plan.resolved) {
    assert(missingLocation(record.candidate.location), 'Plan includes more than a work-arrangement label');
    assert(record.candidate.url && recruiteePostingIdentity(record.candidate.url)
      && recruiteePostingIdentity(record.candidate.url)?.url === recruiteePostingIdentity(record.responseUrl)?.url, 'Posting identity changed');
    assert(record.location.trim() && !missingLocation(record.location), 'Recovered location is empty');
  }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const ids = plan.resolved.map(r => r.candidate.id).sort();
    const { rows: locked } = await client.query<{ row: JobRow }>(`
      SELECT to_jsonb(j) AS row FROM "Job" j WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
    `, [ids]);
    const current = new Map(locked.map(({ row }) => [row.id, row]));
    const applicable = plan.resolved.filter(({ candidate }) => {
      const row = current.get(candidate.id);
      return row && row.source === (candidate.source ?? 'ATS-recruitee') && row.url === candidate.url
        && row.sourceId === candidate.sourceId && row.location === candidate.location && missingLocation(row.location);
    });
    const appliedIds = applicable.map(r => r.candidate.id).sort();
    const beforeRelated = await relatedDigests(client, appliedIds);
    const patches = applicable.map(r => ({ id: r.candidate.id, location: r.location }));
    const updated = await client.query(`UPDATE "Job" j SET location = patch.location
      FROM jsonb_to_recordset($1::jsonb) AS patch(id text, location text) WHERE j.id = patch.id`, [JSON.stringify(patches)]);
    assert.equal(updated.rowCount, patches.length, 'Update count changed');
    const { rows: after } = await client.query<{ row: JobRow }>(
      'SELECT to_jsonb(j) AS row FROM "Job" j WHERE id = ANY($1::text[]) ORDER BY id', [appliedIds]);
    const expected = new Map(patches.map(p => [p.id, p.location]));
    const preserved = after.map(({ row }) => {
      const before = current.get(row.id)!;
      assert.equal(row.location, expected.get(row.id), 'Location update missing');
      const { location: _oldLocation, ...oldProtected } = before;
      const { location: _newLocation, ...newProtected } = row;
      assert.deepEqual(newProtected, oldProtected, `Non-location fields changed on ${row.id}`);
      return { id: row.id, oldLocation: before.location, location: row.location,
        protectedBeforeSha256: canonicalJsonSha256(oldProtected),
        protectedAfterSha256: canonicalJsonSha256(newProtected) };
    });
    assert.equal(after.length, applicable.length, 'Jobs disappeared');
    const afterRelated = await relatedDigests(client, appliedIds);
    assert.deepEqual(afterRelated, beforeRelated, 'Scores, artifacts, histories, or queue items changed');
    // Persist the verification evidence before committing; a receipt write
    // failure aborts the transaction instead of leaving an unaudited repair.
    const receipt = { version: VERSION, selectionHash, verifiedAt: new Date().toISOString(),
      transactionVerified: true, applied: applicable.length,
      skipped: plan.resolved.filter(r => !expected.has(r.candidate.id)).map(r => r.candidate.id),
      protectedColumnsChanged: 0, beforeRelated, afterRelated, preserved };
    await save(receiptFile, { ...receipt, committed: false });
    await client.query('COMMIT');
    await save(receiptFile, { ...receipt, committed: true });
    console.log(JSON.stringify({ mode: 'apply', applied: applicable.length, skipped: receipt.skipped.length,
      protectedColumnsChanged: 0, relatedRecordsChanged: 0, receiptFile }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const validPreview = args.length === 2 && args[0] === '--plan';
  const validApply = args.length === 6 && args[0] === '--apply' && args[2] === '--selection-hash'
    && /^[a-f0-9]{64}$/.test(args[3]) && args[4] === '--receipt';
  if (!validPreview && !validApply) throw new Error('Usage: recover_recruitee_locations.ts --plan <file> | --apply <file> --selection-hash <hash> --receipt <file>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: buildRuntimeDatabaseUrl(process.env.DATABASE_URL, process.env.DATABASE_RUNTIME_HOST) });
  await client.connect();
  try {
    if (validPreview) await preview(client, args[1]);
    else await apply(client, args[1], args[3], args[5]);
  } finally { await client.end(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
