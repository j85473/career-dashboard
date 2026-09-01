import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const route = readFileSync(path.resolve('src/app/api/jobs/search/route.ts'), 'utf8');
const migrations = path.resolve('prisma/migrations/20260901220000_job_description_fts_index/migration.sql');

test('description search queries the exact expression the index is built on', () => {
  const migration = readFileSync(migrations, 'utf8');
  // The index is functional, so the query must name the identical expression.
  // Any divergence -- a different regconfig, a coalesce, a cast -- silently
  // makes the index unusable and the query falls back to de-TOASTing every row.
  assert.match(migration, /USING gin \(to_tsvector\('english', description\)\)/);
  assert.match(route, /to_tsvector\('english', "description"\) @@ websearch_to_tsquery\('english', \$\{query\}\)/);
});

test('description search keeps the optimization fence that forces the index', () => {
  // MATERIALIZED is load-bearing, not stylistic. Without it the planner inlines
  // the CTE, sees an ORDER BY "createdAt" DESC LIMIT it can satisfy by walking
  // Job_createdAt_idx backward, and applies the tsvector as a row filter --
  // re-evaluating to_tsvector per row against TOASTed text. Measured on 735k
  // rows that plan took 20.9s where the fenced bitmap scan took 539ms.
  const matches = route.match(/WITH matches AS MATERIALIZED \(/g) || [];
  assert.equal(matches.length, 2, 'both the windowed and unbounded passes must be fenced');
  assert.doesNotMatch(route, /WITH matches AS \(/);
});

test('description search bounds its own cost and the count that follows it', () => {
  // The recent-first pass is exact, not an approximation: every row outside the
  // window is older than every row inside it, so a filled window already holds
  // the newest matches. Only a short result needs the unbounded pass.
  assert.match(route, /const DESCRIPTION_RECENT_WINDOW_DAYS = 14;/);
  assert.match(route, /"createdAt" >= now\(\) - make_interval\(days => \$\{DESCRIPTION_RECENT_WINDOW_DAYS\}::int\)/);
  assert.match(route, /if \(recent\.length >= DESCRIPTION_MATCH_LIMIT\) return recent\.map/);
  // The id set is bounded so the route's exact count() stays cheap; an exact
  // count cannot short-circuit on LIMIT, which was half the original slowness.
  assert.match(route, /const DESCRIPTION_MATCH_LIMIT = 500;/);
  assert.match(route, /id: \{ in: descriptionMatchIds \}/);
});

test('description is never added back to the substring arms', () => {
  // Descriptions average ~2.1KB and live in TOAST, so an ILIKE arm has to
  // de-TOAST every row it inspects. Measured, title ILIKE returned in 0.67s
  // where the same predicate on description had not finished after 12s.
  const arms = route.slice(route.indexOf('AND: terms.map'), route.indexOf('...(descriptionMatchIds.length'));
  assert.doesNotMatch(arms, /description/);
});
