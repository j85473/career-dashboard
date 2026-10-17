import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalHeuristic } from '../jobScoring';
import { localTriageVerdict, locationTriageVerdict } from '../localTriage';
import { evaluateAuthoritativeMetadata } from '../authoritativeMetadataGate';

// Bounded responsibility excerpts from the October 17 rejected-job review.
const examples = [
  ['Partner Account Manager', 'Remote, United States',
    'Own a named book of established partners. Run joint business plans and quarterly business reviews. '
    + 'Build joint business plans, run the operating cadence, grow managed ARR alongside Sales, Customer Success, and RevOps. '
    + 'Comfortable owning revenue-adjacent outcomes in partnership with Sales, CS, and RevOps. '
    + 'Partner with Sales, Customer Success, and RevOps to grow managed accounts. '
    + 'Collaborate with RevOps on retention and adoption.'],
  ['Sales Enablement Manager', 'U.S Remote',
    'Build onboarding and ramp programs for new sales hires. Create sales materials and deliver training. '
    + 'Partner with Sales Operations on CRM workflows. Work closely with Sales Operations on reporting.'],
  ['Senior Manager, Sales Enablement & Analytics', 'Eden Prairie, MN (Hybrid)',
    'Design and deliver training on a new commercial workflow platform. Lead user readiness, '
    + 'adoption and reinforcement strategies for sales teams.'],
  ['Territory Manager - MN, IA, NE', 'Minneapolis, MN',
    'Grow profitable sales with current and new wholesale customers. Manage retailer relationships '
    + 'and resolve customer issues across the territory.'],
  ['Customer Education Program Manager, Live Learning', 'Remote - US',
    'Own the customer live-learning program. Coach presenters and facilitate practical product training.'],
  ['Territory Sales - Inside Sales Representative', 'Shoreview, MN',
    'Convert inbound inquiries into sales. Grow repeat business, upsell, cross-sell and customer retention.'],
  ['Agent Onboarding and Sales Specialist', 'St Louis Park, MN',
    'Guide new agents through onboarding, platform access, training and their first successful cases.'],
] as const;

test('reviewed commercial and education roles survive all local gates', () => {
  for (const [title, location, fullDescription] of examples) {
    const job = { title, company: 'Example', location, fullDescription, source: 'ATS-test', url: 'https://example.com/job', manualAts: null };
    assert.equal(evaluateAuthoritativeMetadata(job).passes, true, title);
    const heuristic = runLocalHeuristic(job, [], []);
    assert.equal(heuristic.gatePass, true, `${title}: ${heuristic.gateReason}`);
    assert.equal(localTriageVerdict({ ...job, capRationale: heuristic.gatePass ? '' : heuristic.gateReason }).pass, true, title);
  }
});

test('operations ownership still excludes specialist administration', () => {
  for (const title of ['Sales Operations Manager', 'Sales Enablement Manager', 'Partner Account Manager']) {
    const result = runLocalHeuristic({ title, company: 'Example', source: 'test', url: '', manualAts: null,
      fullDescription: 'Own revenue operations, deal desk and CRM administration while collaborating with Sales. Administer quote-to-cash and content governance.' }, [], []);
    assert.equal(result.gatePass, false, title);
    assert.match(result.gateReason, /operations/i);
  }
});

test('collaboration and negated administrative ownership do not reject partner work', () => {
  const result = runLocalHeuristic({ title: 'Partner Account Manager', company: 'Example', source: 'test', url: '', manualAts: null,
    fullDescription: 'Manage existing partner accounts. Partner with the team that manages revenue operations. '
      + 'You will not administer CRM administration or deal desk. Collaborate with Sales Operations on account reviews.' }, [], []);
  assert.equal(result.gatePass, true, result.gateReason);
});

test('new role families retain the primary hunter gate', () => {
  for (const [title] of examples) {
    const result = runLocalHeuristic({ title, company: 'Example', source: 'test', url: '', manualAts: null,
      fullDescription: 'This is exclusively outbound prospecting. Daily cold calls and cold outreach are the primary focus.' }, [], []);
    assert.equal(result.gatePass, false, title);
    assert.match(result.gateReason, /hunter/i);
  }
});

test('explicit nonlocal residence and office requirements still reject', () => {
  for (const title of [
    'Territory Manager - Chicago (Must Live in Territory)',
    'Channel Account Manager - London (Hybrid)',
    'Partner Account Manager - Based in California',
    'Partner Account Manager - Minnesota Territory (Must be based in New York)',
  ]) {
    const result = localTriageVerdict({ title, location: 'Remote', capRationale: '' });
    assert.equal(result.pass, false, title);
    assert.match(result.reason, /requires a non-local work base/i);
  }
  for (const location of ['Remote Work CA', 'USA Remote - FL', 'London, UK; Remote', 'Remote Worldwide; Europe only']) {
    assert.equal(locationTriageVerdict(location).pass, false, location);
  }
});

test('multi-state coverage and worldwide availability do not override a concrete incompatible site', () => {
  assert.equal(localTriageVerdict({ title: 'Territory Manager - MN, IA, NE', location: 'Omaha, NE (Onsite)', capRationale: '' }).pass, false);
  assert.equal(localTriageVerdict({ title: 'Partner Account Manager', company: 'Cintas', location: 'Remote Worldwide', capRationale: '' }).pass, false);
});
