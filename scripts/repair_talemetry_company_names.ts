import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { buildRuntimeDatabaseUrl } from '../src/lib/databaseUrl';
import { reviewedTalemetryEmployer, SYNEOS_CAREERS_EVIDENCE_URL } from '../src/lib/talemetryEmployer';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { isPlaceholderEmployerName } from '../src/lib/companyIdentity';

// Explicit metadata repair only. All scoring inputs retain their existing
// score authority; no ingestion, lifecycle, history, or scoring writer is run.
const VERSION = 'talemetry-placeholder-company-repair-v1';
const RELATED_TABLES = ['JobScoreEvent', 'JobScoringArtifact', 'AimFactualExtraction',
  'JobStatusHistory', 'JobScoringStatusHistory', 'JobPipelineEvent', 'ScoringBatchItem'] as const;
type Candidate = {
  id: string; company: string; title: string; url: string | null; sourceId: string; source: string; description: string; employer: string | null;
  location: string | null; status: string; scoringStatus: string;
  fitScore: number | null; aimFitScore: number | null; reqFitScore: number | null;
};
type Resolved = { candidate: Candidate; company: string; employer: string; evidenceUrl: string; descriptionSha256: string };
type PlanPayload = { version: string; createdAt: string; candidates: number; resolved: Resolved[];
  unavailable: { candidate: Candidate; reason: string }[] };
type Plan = PlanPayload & { selectionHash: string };
type JobRow = Record<string, unknown> & { id: string; company: string; employer: string | null; description: string; url: string | null; source: string; sourceId: string };

async function save(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function resolve(candidate: Candidate): Resolved | { candidate: Candidate; reason: string } {
  if (!candidate.url || !isPlaceholderEmployerName(candidate.company)) return { candidate, reason: 'not_a_placeholder' };
  const company = reviewedTalemetryEmployer(candidate.url, candidate.description);
  if (!company) return { candidate, reason: 'no_unambiguous_reviewed_employer' };
  return { candidate, company, employer: company, evidenceUrl: SYNEOS_CAREERS_EVIDENCE_URL,
    descriptionSha256: canonicalJsonSha256(candidate.description) };
}

async function preview(client: Client, file: string, jobId?: string): Promise<void> {
  const { rows: candidates } = await client.query<Candidate>(`
    SELECT id, company, employer, title, description, url, source, "sourceId", location, status, "scoringStatus",
      "fitScore", "aimFitScore", "reqFitScore"
    FROM "Job" WHERE source = 'ATS-talemetry'
      AND lower(btrim(company)) IN ('company', 'company name', 'company logo', 'employer', 'employer name', 'organization', 'organisation')
      AND ($1::text IS NULL OR id = $1)
    ORDER BY id
  `, [jobId || null]);
  const resolved: Resolved[] = [], unavailable: PlanPayload['unavailable'] = [];
  for (const candidate of candidates) {
    const result = resolve(candidate);
    if ('company' in result) resolved.push(result);
    else unavailable.push(result);
  }
  const payload: PlanPayload = { version: VERSION, createdAt: new Date().toISOString(), candidates: candidates.length, resolved, unavailable };
  const plan: Plan = { ...payload, selectionHash: canonicalJsonSha256(payload) };
  await save(file, plan);
  const companies: Record<string, number> = {};
  for (const row of resolved) companies[row.company] = (companies[row.company] || 0) + 1;
  console.log(JSON.stringify({ mode: 'preview', file, candidates: candidates.length, recovered: resolved.length,
    unavailable: unavailable.length, companies, selectionHash: plan.selectionHash }));
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
    assert(isPlaceholderEmployerName(record.candidate.company), 'Plan includes a real employer label');
    assert.equal(reviewedTalemetryEmployer(record.candidate.url || '', record.candidate.description), record.company, 'Employer evidence changed');
    assert.equal(record.employer, record.company, 'Unreviewed employer grouping');
    assert.equal(canonicalJsonSha256(record.candidate.description), record.descriptionSha256, 'Description evidence changed');
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
      return row && row.source === candidate.source && row.url === candidate.url
        && row.sourceId === candidate.sourceId && row.company === candidate.company
        && canonicalJsonSha256(row.description) === canonicalJsonSha256(candidate.description);
    });
    const appliedIds = applicable.map(r => r.candidate.id).sort();
    const beforeRelated = await relatedDigests(client, appliedIds);
    const patches = applicable.map(r => ({ id: r.candidate.id, company: r.company, employer: r.employer }));
    const updated = await client.query(`UPDATE "Job" j SET company = patch.company, employer = patch.employer
      FROM jsonb_to_recordset($1::jsonb) AS patch(id text, company text, employer text) WHERE j.id = patch.id`, [JSON.stringify(patches)]);
    assert.equal(updated.rowCount, patches.length, 'Update count changed');
    const { rows: after } = await client.query<{ row: JobRow }>(
      'SELECT to_jsonb(j) AS row FROM "Job" j WHERE id = ANY($1::text[]) ORDER BY id', [appliedIds]);
    const expected = new Map(patches.map(p => [p.id, p]));
    const preserved = after.map(({ row }) => {
      const before = current.get(row.id)!;
      assert.equal(row.company, expected.get(row.id)?.company, 'Company update missing');
      assert.equal(row.employer, expected.get(row.id)?.employer, 'Employer update missing');
      const { company: _oldCompany, employer: _oldEmployer, ...oldProtected } = before;
      const { company: _newCompany, employer: _newEmployer, ...newProtected } = row;
      assert.deepEqual(newProtected, oldProtected, `Protected fields changed on ${row.id}`);
      return { id: row.id, oldCompany: before.company, oldEmployer: before.employer, company: row.company, employer: row.employer,
        protectedBeforeSha256: canonicalJsonSha256(oldProtected),
        protectedAfterSha256: canonicalJsonSha256(newProtected) };
    });
    assert.equal(after.length, applicable.length, 'Jobs disappeared');
    const afterRelated = await relatedDigests(client, appliedIds);
    assert.deepEqual(afterRelated, beforeRelated, 'Scores, artifacts, histories, or queue items changed');
    const priorRules: unknown[] = [];
    for (const company of [...new Set(applicable.map(r => r.company))].sort()) {
      const matchKey = company.trim().replace(/\s+/g, ' ').toLowerCase();
      const { rows: prior } = await client.query('SELECT * FROM "CompanyNameRule" WHERE "matchType" = \'label\' AND "matchKey" = $1 FOR UPDATE', [matchKey]);
      if (prior[0]?.origin === 'manual') assert.equal(prior[0].standardName, company, 'Conflicting explicit employer correction');
      priorRules.push(...prior);
      const provenance = applicable.find(r => r.company === company)!;
      await client.query(`INSERT INTO "CompanyNameRule" ("matchType", "matchKey", "standardName", origin, evidence, "provenanceJobId", "createdAt", "updatedAt")
        VALUES ('label', $1, $2, 'manual', $3::jsonb, $4, now(), now())
        ON CONFLICT ("matchType", "matchKey") DO UPDATE SET "standardName" = EXCLUDED."standardName", origin = 'manual',
          evidence = EXCLUDED.evidence, "provenanceJobId" = EXCLUDED."provenanceJobId", "updatedAt" = now()`,
      [matchKey, company, JSON.stringify({ route: VERSION, evidenceUrl: provenance.evidenceUrl, selectionHash }), provenance.candidate.id]);
    }
    // Persist the verification evidence before committing; a receipt write
    // failure aborts the transaction instead of leaving an unaudited repair.
    const receipt = { version: VERSION, selectionHash, verifiedAt: new Date().toISOString(),
      transactionVerified: true, applied: applicable.length,
      skipped: plan.resolved.filter(r => !expected.has(r.candidate.id)).map(r => r.candidate.id),
      protectedColumnsChanged: 0, priorRules, beforeRelated, afterRelated, preserved };
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
  const validPreview = (args.length === 2 || args.length === 4 && args[2] === '--job-id' && /^[a-f0-9-]{36}$/.test(args[3])) && args[0] === '--plan';
  const validApply = args.length === 6 && args[0] === '--apply' && args[2] === '--selection-hash'
    && /^[a-f0-9]{64}$/.test(args[3]) && args[4] === '--receipt';
  if (!validPreview && !validApply) throw new Error('Usage: repair_talemetry_company_names.ts --plan <file> [--job-id <uuid>] | --apply <file> --selection-hash <hash> --receipt <file>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: buildRuntimeDatabaseUrl(process.env.DATABASE_URL, process.env.DATABASE_RUNTIME_HOST) });
  await client.connect();
  try {
    if (validPreview) await preview(client, args[1], args[3]);
    else await apply(client, args[1], args[3], args[5]);
  } finally { await client.end(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
