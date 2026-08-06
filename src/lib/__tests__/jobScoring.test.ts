import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeInvalidJobDescription, runLocalHeuristic } from '../jobScoring';

const resumes = [{
  name: 'Channel Sales',
  text: [
    'strategic account management enterprise customers channel partners',
    'relationship management renewals retention upsell cross-sell',
    'territory management field sales book of business account growth',
  ].join(' '),
}];

function scoreJob(
  title: string,
  fullDescription: string,
  url = 'https://example.com/job',
  manualAts: string | null = null,
  company = 'Example',
) {
  return runLocalHeuristic({
    title,
    company,
    fullDescription,
    url,
    source: 'test',
    manualAts,
  }, resumes, []);
}

test('Prompt Health account roles always clear local scoring without masking the A/E audit', () => {
  const result = scoreJob(
    'Account Executive, SMB',
    'Own net-new logo acquisition through daily cold calls and outbound prospecting.',
    'https://jobs.ashbyhq.com/prompt-health/example',
    null,
    'Prompt Therapy Solutions Inc.',
  );

  assert.equal(result.score, 100);
  assert.equal(result.category, 'promoted');
  assert.equal(result.gatePass, true);
  assert.match(result.rationale, /Prompt Health priority override/i);
  assert.match(result.rationale, /raw A\/E qualification scoring remains auditable/i);
});

test('farming-oriented strategic account roles clear local triage', () => {
  const result = scoreJob(
    'Strategic Account Manager',
    [
      'Own a book of business made up of existing enterprise accounts.',
      'Lead renewals, retention, upsell, and cross-sell planning.',
      'Build trusted advisor relationships with key accounts.',
    ].join(' '),
  );

  assert.deepEqual(
    Object.keys(result).sort(),
    ['score', 'category', 'recommendedResume', 'rationale', 'gatePass', 'gateReason'].sort(),
  );
  assert.ok(result.score >= 60, `expected farming role to pass, received ${result.score}`);
  assert.notEqual(result.category, 'rejected');
  assert.equal(result.recommendedResume, 'Channel Sales');
  assert.match(result.rationale, /farming:/i);
  assert.equal(result.gatePass, true);
});

test('hunter-heavy Account Executive roles stay below triage even on Greenhouse', () => {
  const result = scoreJob(
    'Enterprise Account Executive',
    [
      'This is a hunter role focused on net-new logo acquisition.',
      'Generate outbound pipeline through daily prospecting and cold outreach.',
      'Cold calling and outbound activity are the primary measures of success.',
    ].join(' '),
    'https://boards.greenhouse.io/example/jobs/123',
  );

  assert.ok(result.score < 60, `expected hunter AE to fail, received ${result.score}`);
  assert.match(result.rationale, /Hunter-heavy Account Executive role capped below triage/i);
  assert.equal(result.gatePass, false);
});

test('BDR and SDR titles are deterministic local rejects', () => {
  for (const title of ['Business Development Representative', 'SDR']) {
    const result = scoreJob(title, 'Generate pipeline and schedule meetings for account executives.');
    assert.equal(result.score, 0);
    assert.equal(result.category, 'rejected');
    assert.equal(result.recommendedResume, null);
  }
});

test('pure operations, enablement, deal desk, and Tier 1 support titles are rejected', () => {
  const titles = [
    'RevOps Manager',
    'Sales Operations Analyst',
    'Deal Desk Specialist',
    'Sales Enablement Manager',
    'Tier 1 Support Representative',
  ];

  for (const title of titles) {
    const result = scoreJob(title, 'Support internal processes, systems, reporting, and administrative workflows.');
    assert.equal(result.score, 0, `${title} should be rejected`);
    assert.equal(result.category, 'rejected');
  }
});

test('software engineering, scientist, and service desk titles are deterministic rejects', () => {
  const titles = [
    'Software Engineering Manager',
    'Director Of Software Engineering and Architecture',
    'Senior Scientist',
    'Senior or Principal Scientist, Formulation and Process Development',
    'Service Desk Manager',
    'Senior IT Service Desk Analyst',
  ];

  for (const title of titles) {
    const result = scoreJob(title, 'Lead a cross-functional team, manage stakeholders, and drive strategic initiatives.');
    assert.equal(result.score, 0, `${title} should be rejected`);
    assert.equal(result.category, 'rejected');
    assert.equal(result.recommendedResume, null);
  }
});

test('commercial-looking conflict titles are deterministic rejects', () => {
  const titles = [
    'Quality Control Analyst',
    'Claims Adjustor',
    'Staff Forward Deployed AI Solutions Engineer',
    'Controller (Remote US)',
    'Lead Public Relations',
    'Account Executive, Public Relations (B2B Technology)',
    'Account Director, Medical Communications',
    'Senior IT Operations Engineer',
  ];

  for (const title of titles) {
    const result = scoreJob(title, 'Manage stakeholders, customers, strategic programs, and cross-functional relationships.');
    assert.equal(result.score, 0, `${title} should be rejected`);
    assert.equal(result.category, 'rejected');
    assert.equal(result.recommendedResume, null);
  }
});

test('ATS metadata and resume vocabulary cannot rescue an unrecognized role family', () => {
  const result = scoreJob(
    'Senior Producer',
    'Manage strategic relationships, cross-functional partners, retention, travel, and business outcomes.',
    'https://boards.greenhouse.io/example/jobs/789',
  );

  assert.ok(result.score < 60, `expected unrelated title to fail, received ${result.score}`);
  assert.match(result.rationale, /No target sales, account management, partnerships, or customer success title signal/i);
});

test('operations-heavy descriptions fail even when the title is ambiguous', () => {
  const result = scoreJob(
    'Revenue Analyst',
    'Partner with RevOps, SalesOps, and Deal Desk on internal reporting, process administration, and sales enablement.',
    'https://boards.greenhouse.io/example/jobs/456',
  );

  assert.ok(result.score < 60, `expected operations role to fail, received ${result.score}`);
  assert.match(result.rationale, /Operations\/admin saturation capped the score below triage/i);
});

test('generic Sales Manager and Customer Success titles are scored from their responsibilities', () => {
  const farmingSalesManager = scoreJob(
    'Sales Manager',
    'Manage existing accounts, renewals, retention, and relationship management across a book of business.',
  );
  const hunterSalesManager = scoreJob(
    'Sales Manager',
    'Lead outbound prospecting, cold calling, net-new logo acquisition, hunting, and pipeline generation.',
  );
  const farmingCustomerSuccess = scoreJob(
    'Customer Success Manager',
    'Own renewals, retention, upsell, and long-term relationships for existing enterprise customers.',
  );

  assert.ok(farmingSalesManager.score >= 60);
  assert.ok(farmingCustomerSuccess.score >= 60);
  assert.ok(hunterSalesManager.score < 60);
});

test('recognized partnership and consultative sales variants remain eligible', () => {
  const partnershipManager = scoreJob(
    'Strategic Partnerships Manager',
    'Manage channel partners, joint business reviews, renewals, and expansion across an assigned portfolio.',
  );
  const solutionsConsultant = scoreJob(
    'Senior Solutions Consultant',
    'Serve as a trusted advisor to existing enterprise customers and support strategic account growth.',
  );
  const salesEngineer = scoreJob(
    'Enterprise Sales Engineer',
    'Act as a trusted technical advisor for strategic accounts and support the field sales organization.',
  );

  assert.ok(partnershipManager.score >= 60);
  assert.ok(solutionsConsultant.score >= 60);
  assert.ok(salesEngineer.score >= 60);
});

test('ATS platform never changes the local fit score', () => {
  const description = 'Manage relationship development and a portfolio of assigned accounts.';
  const unknown = scoreJob('Account Manager', description);
  const workday = scoreJob('Account Manager', description, 'https://example.myworkdayjobs.com/en-US/job/123');
  const lever = scoreJob('Account Manager', description, 'https://jobs.lever.co/example/123');
  const greenhouse = scoreJob('Account Manager', description, 'https://boards.greenhouse.io/example/jobs/123');
  const ashby = scoreJob('Account Manager', description, 'https://jobs.ashbyhq.com/example/123');
  const successFactors = scoreJob(
    'Account Manager',
    description,
    'https://example.com/job',
    'SuccessFactors',
  );

  for (const result of [workday, lever, greenhouse, ashby, successFactors]) {
    assert.equal(result.score, unknown.score);
    assert.doesNotMatch(result.rationale, /\bATS [+-]\d+/);
  }
});

test('recognized target titles reach A/E even when their rank score is below 60', () => {
  for (const title of ['Territory Sales Manager', 'Customer Sales Manager', 'Client Success Specialist']) {
    const result = scoreJob(title, 'Manage assigned commercial customers and coordinate account activity.');
    assert.equal(result.gatePass, true, `${title}: ${result.gateReason}`);
  }
});

test('frozen commercial-growth resume role families reach A/E review', () => {
  const cases = [
    {
      title: 'Distributor Manager',
      description: 'Manage a multi-state distributor network, partner performance, and territory growth.',
    },
    {
      title: 'Channel Enablement Manager',
      description: 'Build partner readiness, operating reviews, field adoption, and corrective-action plans.',
    },
    {
      title: 'Market Development Manager',
      description: 'Lead market expansion, field execution, sell-in, and route-to-market programs.',
    },
    {
      title: 'Commercial Operations Manager',
      description: 'Improve field sales performance reporting, partner accountability, and GTM execution.',
    },
    {
      title: 'Sales Effectiveness Manager',
      description: 'Build data-driven performance workflows for regional field sales and distributor teams.',
    },
    {
      title: 'Area Business Manager',
      description: 'Own territory growth, distributor execution, market development, and key-account performance.',
    },
    {
      title: 'Market Execution Manager',
      description: 'Lead in-market execution, sell-in, product launches, and partner performance reviews.',
    },
    {
      title: 'Sales Enablement Manager - Field Sales',
      description: 'Build field coaching, partner readiness, scalable playbooks, and distributor accountability.',
    },
  ];

  for (const job of cases) {
    const result = scoreJob(job.title, job.description);
    assert.equal(result.gatePass, true, `${job.title}: ${result.gateReason}; ${result.rationale}`);
    assert.match(result.rationale, /commercial growth/i);
  }
});

test('mixed full-cycle account roles are reviewed instead of being mistaken for pure hunters', () => {
  const result = scoreJob(
    'Mid-Market Account Executive',
    [
      'Own a named portfolio and grow existing customer relationships through retention and expansion.',
      'Build pipeline through referrals, partner channels, and selective prospecting.',
      'Close net-new business while leading quarterly business reviews and cross-sell planning.',
    ].join(' '),
  );

  assert.equal(result.gatePass, true, result.gateReason);
  assert.doesNotMatch(result.rationale, /Primary hunter\/cold-outbound motion capped/i);
});

test('saturated acquisition language without account-growth balance remains blocked', () => {
  const result = scoreJob(
    'Enterprise Account Executive',
    [
      'Win net-new logos and generate new business across the region.',
      'Build self-sourced pipeline through outbound prospecting and cold outreach.',
      'Use cold calling and lead generation to acquire new customers.',
    ].join(' '),
  );

  assert.equal(result.gatePass, false, result.gateReason);
  assert.match(result.gateReason, /hunter/i);
});

test('low-scoring acquisition titles need farming evidence even without explicit cold outbound', () => {
  for (const title of ['Mid-Market Account Executive', 'Outside Sales Representative', 'Business Development Manager']) {
    const result = scoreJob(
      title,
      'Build pipeline, win new customers, manage the sales cycle, and close new business in an assigned market.',
    );
    assert.equal(result.gatePass, false, `${title}: ${result.rationale}`);
    assert.match(result.gateReason, /lacks farming\/account-growth balance/i);
  }
});

test('commercial qualifiers do not rescue pure internal operations administration', () => {
  for (const title of ['RevOps Manager', 'Sales Operations Manager', 'Sales Enablement Manager']) {
    const result = scoreJob(
      title,
      'Administer Salesforce, quote-to-cash, forecast hygiene, content governance, and internal systems.',
    );
    assert.equal(result.gatePass, false, title);
    assert.equal(result.score, 0, title);
  }
});

test('Epicor-style primary prospecting remains a local gate reject', () => {
  const result = scoreJob(
    'Territory Sales Manager',
    'Prospects throughout the assigned territory to maintain pipeline at 5X annual quota.',
  );
  assert.equal(result.gatePass, false);
  assert.match(result.gateReason, /hunter/i);
});

test('closed and cookie-only pages are not accepted as job descriptions', () => {
  assert.equal(looksLikeInvalidJobDescription('The page you are looking for does not exist. Search for jobs.'), true);
  assert.equal(looksLikeInvalidJobDescription('Cookie Preferences Manage Cookies Accept All Cookies'), true);
  assert.equal(looksLikeInvalidJobDescription('Responsibilities include territory growth. Qualifications include five years of sales experience.'), false);
});
