import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDealerDistributorAccountEvidence } from '../commercialRoleDiscovery';
import { passesPreFilter } from '../jobFiltering';
import { runLocalHeuristic } from '../jobScoring';
import { localTriageVerdict } from '../localTriage';
import { evaluateAuthoritativeMetadata } from '../authoritativeMetadataGate';

function assess(title: string, fullDescription: string) {
  const job = { title, fullDescription, company: 'Example', location: 'Minneapolis, MN', source: 'test', url: '', manualAts: null };
  return { job, result: runLocalHeuristic(job, [], []) };
}

// Bounded responsibility excerpts from the October 20 rejected-job review.
const reviewedExamples = [
  ['Dealer Development Specialist',
    'Improve dealer profitability through business planning and guidance.\n'
    + 'Monitor dealer performance and drive monthly/quarterly targets.\n'
    + 'Collaborate with Sales teams and Dealership leaders to improve dealer performance.\n'
    + 'Strengthen dealer network to improve market reach and sales.'],
  ['Distributor Growth Lead – Industrial Aftermarket (Hybrid)',
    'Manage large distributor relationships and drive revenue through resellers. Conduct trainings on products to resellers and coach them on how to sell to their customer base.'],
  ['Dealer Marketing Consultant - Minneapolis',
    'Work directly with our client and their dealers to implement digital best practices through in-person consultations, training, data analysis, videos, and webinars.'],
  ['Wholesale Auto Parts Distributor Sales Executive',
    'Managing the day-to-day relationship with national auto parts wholesalers and dealership channel customers. Traveling to sales regions to train the sellers on the private label powertrain program.'],
  ['District Retail Manager',
    'Develop and maintain strong dealer relationships to meet district sales objectives. Coach dealers on product training and business plans.'],
] as const;

test('reviewed dealer and distributor duties admit alternate titles through all local gates', () => {
  for (const [title, description] of reviewedExamples) {
    const { job, result } = assess(title, description);
    assert.equal(passesPreFilter({ ...job, description }).passes, true, title);
    assert.equal(result.gatePass, true, `${title}: ${result.gateReason}`);
    assert.match(result.rationale, /dealer\/distributor account duties/, title);
    assert.equal(localTriageVerdict({ ...job, capRationale: result.gatePass ? '' : result.gateReason }).pass, true, title);
  }
});

test('Integral dx role reaches review across aggregator and direct ATS metadata and presentation variants', () => {
  const [title, duties] = reviewedExamples[0];
  for (const source of ['SerpApi', 'JSearch', 'ATS-iSolvedHire']) {
    for (const description of [
      `Compensation is $60,000+, dependent on experience\n${duties}`,
      `Compensation is $60,000 to $90,000, dependent on experience\n${duties.replace(/^/gm, '• ')}`,
    ]) {
      const job = {
        title, company: 'Integral dx', location: 'Minneapolis, MN', source,
        url: 'https://integraldx.isolvedhire.com/jobs/1864345.html', manualAts: null,
        description, fullDescription: description,
      };
      assert.equal(passesPreFilter(job).passes, true, source);
      assert.equal(evaluateAuthoritativeMetadata(job).passes, true, source);
      const result = runLocalHeuristic(job, [], []);
      assert.equal(result.gatePass, true, `${source}: ${result.gateReason}`);
      assert.equal(localTriageVerdict({
        ...job, capRationale: result.gatePass ? '' : result.gateReason,
      }).pass, true, source);
    }
  }
});

test('explicit dealer coaching can admit a title without an account-management label', () => {
  const { result } = assess('Regional Business Consultant', 'Train dealers on product features and coach resellers on sales performance.');
  assert.equal(result.gatePass, true, result.gateReason);
});

test('network words, generic stakeholders, negated duties and unrelated occupations do not supply admission evidence', () => {
  for (const [title, description] of [
    ['Distributor Growth Lead', 'Our distributors sell products nationwide. Manage internal schedules and reports.'],
    ['Dealer Marketing Consultant', 'Manage stakeholders, strategic initiatives and internal marketing assets.'],
    ['Dealer Business Consultant', 'You will not manage dealer accounts or train distributors.'],
    ['District Retail Manager', 'Manage store staffing, cash registers and opening procedures.'],
    ['Warehouse Manager', 'Manage distributor relationships and train dealers on sales.'],
    ['Retail Store Manager', 'Manage dealer relationships and coach dealers on sales performance.'],
    ['Software Engineer', 'Manage dealer accounts and train distributors on products.'],
  ]) {
    assert.equal(hasDealerDistributorAccountEvidence(title, description), false, title);
    assert.equal(assess(title, description).result.gatePass, false, title);
  }
});

test('alternate dealer and distributor roles retain hunter and administrative motion gates', () => {
  for (const [title, description] of reviewedExamples) {
    for (const excludedMotion of [
      'This is exclusively outbound prospecting. Daily cold calls and cold outreach are the primary focus.',
      'Own revenue operations, deal desk and CRM administration. Administer quote-to-cash and content governance.',
    ]) {
      const { result } = assess(title, `${description} ${excludedMotion}`);
      assert.equal(result.gatePass, false, title);
      assert.match(result.gateReason, /hunter|operations/i, title);
    }
  }
});

test('description-based admission still respects employer and work-base exclusions', () => {
  const { job, result } = assess(...reviewedExamples[0]);
  assert.equal(result.gatePass, true);
  for (const overrides of [
    { company: 'Cintas' },
    { location: 'Austin, TX (Onsite)' },
    { title: 'Distributor Growth Lead - Must live in California' },
  ]) {
    assert.equal(localTriageVerdict({ ...job, capRationale: '', ...overrides }).pass, false);
  }
});
