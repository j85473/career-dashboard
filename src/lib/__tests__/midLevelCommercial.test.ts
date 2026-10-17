import assert from 'node:assert/strict';
import test from 'node:test';
import { MID_LEVEL_JOB_SEARCH_QUERIES } from '../jobSearchQueries';
import { hasMidLevelCommercialTitle } from '../commercialRoleDiscovery';
import { runLocalHeuristic } from '../jobScoring';
import { passesPreFilter } from '../jobFiltering';
import { canonicalIngestionTaskDefinitions } from '../ingestionTaskCatalog';
import { normalizeQueryFamily } from '../ingestionControl';

function triage(title: string, fullDescription: string) {
  return runLocalHeuristic({ title, fullDescription, company: 'Example', source: 'test', url: '', manualAts: null }, [], []);
}

test('mid-level titles reach review without leadership titles, large scope or direct reports', () => {
  for (const title of [...MID_LEVEL_JOB_SEARCH_QUERIES, 'Customer Success Associate', 'Coordinator, Client Success', 'Associate, Partner Enablement']) {
    const result = triage(title, 'Support assigned customer and partner accounts through onboarding, training and retention. This is an individual contributor role.');
    assert.equal(result.gatePass, true, `${title}: ${result.gateReason}`);
  }
});

test('mid-level search titles materialize for every existing paid provider and local source', () => {
  const definitions = canonicalIngestionTaskDefinitions({});
  for (const title of MID_LEVEL_JOB_SEARCH_QUERIES) {
    const family = normalizeQueryFamily(title);
    for (const source of ['SerpApi', 'JSearch', 'LinkedIn', 'Glassdoor (RapidAPI)', 'CareerForce']) {
      assert.ok(definitions.some(d => d.spec.source === source && d.spec.queryFamily === family), `${source}: ${title}`);
    }
  }
});

test('a clinical market does not make a commercial specialist a clinician', () => {
  const job = { company: 'Example', location: 'Minneapolis, MN', description: '', url: '' };
  assert.equal(passesPreFilter({ ...job, title: 'Clinical Customer Success Specialist' }).passes, true);
  assert.equal(passesPreFilter({ ...job, title: 'Clinical Nurse Customer Success Specialist' }).passes, false);
});

test('generic coordinators and specialist occupations do not become commercial by seniority alone', () => {
  for (const title of ['Administrative Coordinator', 'Onboarding Coordinator', 'Human Resources Specialist', 'Clinical Specialist', 'Billing Specialist', 'Partner Marketing Specialist']) {
    assert.equal(hasMidLevelCommercialTitle(title), false, title);
    assert.equal(triage(title, 'Coordinate internal workflows, schedules and documents.').gatePass, false, title);
  }
});

test('mid-level roles keep the hunter and administrative ownership gates', () => {
  for (const title of MID_LEVEL_JOB_SEARCH_QUERIES) {
    assert.equal(triage(title, 'This is exclusively outbound prospecting. Daily cold calls and cold outreach are the primary focus.').gatePass, false, title);
    assert.equal(triage(title, 'Own revenue operations, deal desk and CRM administration. Administer quote-to-cash and content governance.').gatePass, false, title);
  }
});
