import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessJobDescriptionQuality,
  isClosedJobPosting,
  looksLikeInvalidJobDescription,
  runLocalHeuristic,
} from '../jobScoring';
import { MIN_SCORABLE_JD_CHARACTERS, SUBSTANTIAL_JD_CHARACTERS } from '../jobDescriptionQuality';

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

// Local triage now withholds roles the heuristic has already capped below its
// own bar. Aim and Experience are the paid AI evaluation; they are not a sieve
// for 26,000 postings, 87% of which had no target title signal at all. The
// tests below previously asserted the opposite invariant — that nothing could
// be rejected before Aim — which is what let a Food Services Attendant queue
// for AI review. Aim still owns preference hard stops for everything that
// reaches it, and nothing here promotes a job.

test('Prompt Health has no company-specific local override', () => {
  const result = scoreJob(
    'Account Executive, SMB',
    'Own net-new logo acquisition through daily cold calls and outbound prospecting.',
    'https://jobs.ashbyhq.com/prompt-health/example',
    null,
    'Prompt Therapy Solutions Inc.',
  );

  // A daily-cold-call acquisition role is capped below triage on its own
  // merits; the point of this test is that no company-specific override exists.
  assert.equal(result.gatePass, false);
  assert.match(result.gateReason, /capped below triage/i);
  assert.doesNotMatch(result.rationale, /Prompt Health priority override/i);
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

test('hunter-heavy Account Executive is triaged out before Aim', () => {
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
  assert.match(result.gateReason, /capped below triage/i);
});

test('BDR and SDR ranks are triaged out before Aim', () => {
  for (const title of ['Business Development Representative', 'SDR']) {
    const result = scoreJob(title, 'Generate pipeline and schedule meetings for account executives.');
    assert.equal(result.gatePass, false);
  }
});

test('operations and support ranks are triaged out before Aim', () => {
  const titles = [
    'RevOps Manager',
    'Sales Operations Analyst',
    'Deal Desk Specialist',
    'Sales Enablement Manager',
    'Tier 1 Support Representative',
  ];

  for (const title of titles) {
    const result = scoreJob(title, 'Support internal processes, systems, reporting, and administrative workflows.');
    assert.equal(result.gatePass, false, title);
  }
});

test('non-target titles are triaged out before Aim', () => {
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
    assert.equal(result.gatePass, false, title);
  }
});

const CONFLICT_DESCRIPTION =
  'Manage stakeholders, customers, strategic programs, and cross-functional relationships.';

test('commercial-sounding titles with no target signal are triaged out', () => {
  // Adjacent vocabulary — "stakeholders", "customers", "strategic" — is not a
  // target title signal, and these are precisely the roles that filled the Aim
  // queue.
  for (const title of [
    'Quality Control Analyst',
    'Claims Adjustor',
    'Controller (Remote US)',
    'Lead Public Relations',
    'Senior IT Operations Engineer',
  ]) {
    const result = scoreJob(title, CONFLICT_DESCRIPTION);
    assert.equal(result.gatePass, false, title);
    assert.match(result.gateReason, /title signal/i, title);
  }
});

test('a real target title still reaches Aim even in an off-target industry', () => {
  // Triage is title-signal based, not industry based. Whether a public-relations
  // or medical-communications employer is worth pursuing is Aim's decision, and
  // these keep a genuine account-management title.
  for (const title of [
    'Account Executive, Public Relations (B2B Technology)',
    'Account Director, Medical Communications',
    'Staff Forward Deployed AI Solutions Engineer',
  ]) {
    const result = scoreJob(title, CONFLICT_DESCRIPTION);
    assert.equal(result.gatePass, true, title);
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

test('saturated acquisition language is triaged out before Aim', () => {
  const result = scoreJob(
    'Enterprise Account Executive',
    [
      'Win net-new logos and generate new business across the region.',
      'Build self-sourced pipeline through outbound prospecting and cold outreach.',
      'Use cold calling and lead generation to acquire new customers.',
    ].join(' '),
  );

  assert.equal(result.gatePass, false, result.gateReason);
});

test('low-scoring acquisition titles still reach Aim, because nothing capped them', () => {
  for (const title of ['Mid-Market Account Executive', 'Outside Sales Representative', 'Business Development Manager']) {
    const result = scoreJob(
      title,
      'Build pipeline, win new customers, manage the sales cycle, and close new business in an assigned market.',
    );
    assert.equal(result.gatePass, true, `${title}: ${result.rationale}`);
  }
});

test('commercial operations metadata is triaged out before Aim', () => {
  for (const title of ['RevOps Manager', 'Sales Operations Manager', 'Sales Enablement Manager']) {
    const result = scoreJob(
      title,
      'Administer Salesforce, quote-to-cash, forecast hygiene, content governance, and internal systems.',
    );
    assert.equal(result.gatePass, false, title);
  }
});

test('Epicor-style primary prospecting is triaged out before Aim', () => {
  const result = scoreJob(
    'Territory Sales Manager',
    'Prospects throughout the assigned territory to maintain pipeline at 5X annual quota.',
  );
  assert.equal(result.gatePass, false);
});

test('closed and cookie-only pages are not accepted as job descriptions', () => {
  assert.equal(looksLikeInvalidJobDescription('The page you are looking for does not exist. Search for jobs.'), true);
  assert.equal(looksLikeInvalidJobDescription('Cookie Preferences Manage Cookies Accept All Cookies'), true);
  assert.equal(looksLikeInvalidJobDescription('Responsibilities include territory growth. Qualifications include five years of sales experience.'), false);
});

test('qualification scoring fails closed on short snippets and portal shells', () => {
  assert.deepEqual(
    assessJobDescriptionQuality('Manage partner accounts. Five years of experience required.'),
    { scorable: false, reason: 'fewer than 650 usable characters' },
  );
  assert.equal(
    assessJobDescriptionQuality('Sign in to apply. Create an account. Search jobs. No results found.').scorable,
    false,
  );

  const complete = [
    'In this role you will own an assigned portfolio of distributor and reseller relationships across a multi-state territory.',
    'Responsibilities include joint business planning, partner enablement, quarterly operating reviews, sell-through growth, product launches, and regular field travel.',
    'You will develop account plans, coordinate with internal teams, identify expansion opportunities, and communicate performance risks to executives.',
    'Required qualifications include at least five years of channel sales or partner account management experience and demonstrated territory growth.',
    'Candidates must have strong communication, analytical, and relationship-management skills. A bachelor degree and CRM reporting experience are preferred.',
  ].join(' ');
  assert.deepEqual(assessJobDescriptionQuality(complete), {
    scorable: true,
    reason: null,
    signals: { hasUsableDuties: true, hasUsableQualifications: true },
  });

  const compactAtsPosting = [
    'Job Description',
    'The Key Account Manager is responsible for maintaining, retaining, and growing customers through relationship-building within an assigned territory.',
    'The manager ensures timely implementation of customer programs, service standards, and account plans that improve the customer experience.',
    'Skills/Qualifications',
    'Required: 2-3 years business experience, a valid driver license, and customer relations or business-to-business sales experience.',
    'Preferred: bachelor degree, CRM proficiency, effective communication, and experience providing service to a broad customer base.',
    'This full-time position includes benefits, paid time off, professional development, and regular travel within the territory.',
  ].join(' ');
  assert.deepEqual(assessJobDescriptionQuality(compactAtsPosting), {
    scorable: true,
    reason: null,
    signals: { hasUsableDuties: true, hasUsableQualifications: true },
  });

  const narrativePosting = [
    'What the job actually is',
    'You will reach out to properties, follow up consistently, meet maintenance supervisors, and learn what each customer needs.',
    'The work combines phone-based account development with property visits, relationship selling, service follow-through, and repeat monthly contact.',
    'What we are looking for',
    'Applicants need prior business-to-business sales or customer-service experience, comfort with technical products, and strong follow-up habits.',
    'The position also requires clear written and verbal communication, independent time management, CRM documentation, and reliable local transportation.',
    'The company provides a base salary, commission, health coverage, paid time off, product training, and a collaborative account-support team.',
  ].join(' ');
  assert.deepEqual(assessJobDescriptionQuality(narrativePosting), {
    scorable: true,
    reason: null,
    signals: { hasUsableDuties: true, hasUsableQualifications: true },
  });
});

test('a substantial description is scorable even when it misses the duties/qualifications vocabulary', () => {
  // Sysmex America, "Consultant, Hemostasis Optimization" — a real posting
  // that opens with company boilerplate and states duties in prose that
  // never hits the keyword list. Widening the regexes again would still miss
  // the next posting shaped like this one.
  const boilerplateOpening = [
    'Sysmex America is a global leader in laboratory diagnostics, headquartered in Lincolnshire, Illinois, and part of Sysmex Corporation, founded in Kobe, Japan in 1968.',
    'Sysmex serves clinical laboratories nationwide with hematology, hemostasis, and urinalysis testing systems, and invests heavily in research and development.',
    'Sysmex America values a diverse and inclusive workplace culture across its offices and is an equal opportunity employer committed to fair hiring practices.',
    'Employees enjoy a competitive package including health coverage, a retirement match, paid holidays, and ongoing professional education.',
    'The Hemostasis Optimization Consultant travels across Wisconsin, Minnesota, North Dakota, and South Dakota, meeting laboratory directors and hospital administrators.',
    'This person builds relationships with laboratory staff, walks through workflow changes on-site, and follows up by phone between visits.',
    'A clinical laboratory science background and prior hospital or reference-lab experience are typical for people who succeed in this kind of field-based, customer-facing position.',
    'Sysmex offers a company vehicle, travel reimbursement, and a structured onboarding program for people new to field-based laboratory consulting.',
    'The team meets quarterly in Lincolnshire for planning sessions, product updates, and cross-functional collaboration with marketing and R&D colleagues.',
    'Sysmex America has held its Great Place to Work certification for several consecutive years and highlights that recognition throughout its careers site.',
  ].join(' ');
  assert.ok(boilerplateOpening.length >= SUBSTANTIAL_JD_CHARACTERS, `fixture is ${boilerplateOpening.length} chars`);

  const result = assessJobDescriptionQuality(boilerplateOpening);
  assert.equal(result.scorable, true);
  assert.equal(result.reason, null);
  assert.ok(result.signals);
});

test('a short description without the vocabulary still fails closed below the substantial threshold', () => {
  // Mackinnon Bruce, "Key Account Manager" — rejected for no usable
  // qualifications at 1,040 chars, well under the 1,500-char bar. A miss this
  // short is still useful fail-closed evidence.
  const shortNoQualifications = [
    'This role manages a portfolio of key accounts across the assigned region.',
    'The account manager builds relationships with distributor partners and drives territory growth.',
    'Day-to-day work includes account planning, partner coordination, and pipeline reviews.',
  ].join(' ').repeat(4);
  assert.ok(shortNoQualifications.length >= MIN_SCORABLE_JD_CHARACTERS);
  assert.ok(shortNoQualifications.length < SUBSTANTIAL_JD_CHARACTERS, `fixture is ${shortNoQualifications.length} chars`);

  assert.deepEqual(assessJobDescriptionQuality(shortNoQualifications), {
    scorable: false,
    reason: 'no usable qualifications',
    signals: { hasUsableDuties: true, hasUsableQualifications: false },
  });
});

test('a long portal shell is still rejected regardless of length', () => {
  // IBAC, "Title TBD" — RemoteOK navigation chrome at 5,865 chars. The
  // substantial-length bypass must never reach shell detection, which runs
  // first and unconditionally.
  const longShell = 'Join Remote OK. Log in. Frontpage. Dark mode. Sign in to apply. Search jobs. '.repeat(30);
  assert.ok(longShell.length >= SUBSTANTIAL_JD_CHARACTERS, `fixture is ${longShell.length} chars`);

  assert.deepEqual(assessJobDescriptionQuality(longShell), {
    scorable: false,
    reason: 'expired, closed, login, cookie, or portal shell',
  });
});

test('RemoteOK navigation chrome stays rejected when the page also contains job vocabulary', () => {
  // A real page-wide/Jina capture can include both the shell and a posting (or
  // other job cards), so duties and qualifications must not rescue the page.
  const mixedPage = [
    'Join Remote OK. Log in. General. Frontpage. Remote jobs. Dark mode.',
    'Hire remote workers. Post a job. Go premium. Top jobs.',
    'Responsibilities include managing customer accounts and driving territory revenue.',
    'Qualifications require five years of sales experience and a bachelor degree.',
  ].join(' ').repeat(8);
  assert.ok(mixedPage.length >= SUBSTANTIAL_JD_CHARACTERS, `fixture is ${mixedPage.length} chars`);

  assert.deepEqual(assessJobDescriptionQuality(mixedPage), {
    scorable: false,
    reason: 'expired, closed, login, cookie, or portal shell',
  });
});

test('ordinary remote-work language is not mistaken for RemoteOK navigation', () => {
  const legitimate = [
    'This remote role manages a national portfolio of channel partners and distributor accounts.',
    'Responsibilities include account planning, pipeline reviews, and territory growth.',
    'Qualifications require five years of sales experience and CRM proficiency.',
  ].join(' ').repeat(4);

  assert.equal(assessJobDescriptionQuality(legitimate).scorable, true);
});

test('pay-transparency boilerplate does not read as a closed posting', () => {
  // Verbatim from a 15k-character Nutanix listing that was discarded over this clause.
  assert.equal(looksLikeInvalidJobDescription(
    'The posting may be removed prior to this date if the position is filled or extended in good faith. '
    + 'Responsibilities include revenue operations partnership. Qualifications include five years of experience.',
  ), false);
  assert.equal(looksLikeInvalidJobDescription(
    'Applications are accepted until the posting is closed. Responsibilities include territory growth.',
  ), false);
});

test('conditional application-window language is not mistaken for a filled position', () => {
  for (const phrase of [
    'Applications are reviewed until a position has been filled.',
    'We stop accepting applications when an open position has been filled.',
    'We may close this posting if our position has been filled.',
  ]) {
    assert.equal(looksLikeInvalidJobDescription(
      `${phrase} Responsibilities include account growth. Qualifications include five years of sales experience.`,
    ), false, phrase);
  }
  assert.equal(looksLikeInvalidJobDescription('The position has been filled.'), true);
});

test('an open-until-filled deadline does not read as a closed posting', () => {
  // Verbatim from an Agilent listing discarded over its application deadline.
  assert.equal(looksLikeInvalidJobDescription(
    'Applications will be accepted until at least August 12, 2026 or until the job is no longer posted. '
    + 'Responsibilities include territory growth. Qualifications include five years of experience.',
  ), false);
});

test('an accommodation hotline is not a 404', () => {
  // Oracle listings carry this number in both formats; four were discarded over
  // the digits alone, so 404 now needs the HTTP context that gives it meaning.
  for (const number of ['1-888-404-2494', '+1 888 404 2494']) {
    assert.equal(looksLikeInvalidJobDescription(
      `Contact accommodation-request@oracle.com or call ${number} in the United States. `
      + 'Responsibilities include account management. Qualifications include five years of experience.',
    ), false, `${number} should not read as a dead page`);
  }
  // A scraper recording a real fetch failure must still be caught.
  assert.equal(looksLikeInvalidJobDescription('Warning: target URL returned error 404: Not Found'), true);
  assert.equal(looksLikeInvalidJobDescription('404 Not Found. The page you requested is unavailable.'), true);
});

test('a genuinely closed posting is still rejected', () => {
  assert.equal(looksLikeInvalidJobDescription('This position has been filled. Browse other openings.'), true);
  assert.equal(looksLikeInvalidJobDescription('The posting is closed and no longer accepting applications.'), true);
  assert.equal(looksLikeInvalidJobDescription('This job is no longer available.'), true);
  assert.equal(isClosedJobPosting('Applications are no longer being accepted for this position.'), true);
  assert.equal(isClosedJobPosting('This requisition has been cancelled.'), true);
  assert.equal(isClosedJobPosting('This job is no longer available.'), true);
  assert.equal(isClosedJobPosting('404 Not Found. The page you requested is unavailable.'), false);
  assert.equal(isClosedJobPosting('Sign in to apply. Search jobs.'), false);
});

test('channel account manager remains a high-value target role without being a held-title claim', () => {
  const explicit = scoreJob(
    'Channel Account Manager',
    'Manage a portfolio of distribution partners and drive sell-through across the territory.',
  );
  const generic = scoreJob(
    'Channel Sales Manager',
    'Manage a portfolio of distribution partners and drive sell-through across the territory.',
  );
  assert.ok(
    explicit.score > generic.score,
    `channel account manager (${explicit.score}) must outscore channel sales manager (${generic.score})`,
  );
});

test('normalized target-title families preserve the known human-relevant false negatives', () => {
  const titles = [
    'Manager, Channel Sales',
    'Partner Business Manager (PBM)',
    'National Partner Channel Mgr',
    'District Channel Manager Enterprise Accounts',
    'Manager Customer Success RMM',
    'Senior Customer Manager Regional Grocery Wholesale',
    'Director Roundel Partner Solutions',
    'Territory Manger',
  ];

  for (const title of titles) {
    const result = scoreJob(
      title,
      'Manage assigned partner and customer relationships across a regional territory with account growth, retention, and recurring travel.',
    );
    assert.equal(result.gatePass, true, `${title}: ${result.gateReason}; ${result.rationale}`);
    assert.notEqual(result.category, 'rejected', title);
  }
});

test('channel vocabulary in the body earns commercial-growth credit', () => {
  const withChannelLanguage = scoreJob(
    'Channel Account Manager',
    [
      'Own two-tier distribution through our authorized reseller base.',
      'Manage deal registration, MDF, and the partner program tiers.',
      'Accountable for sell-through and distributor management across the region.',
    ].join(' '),
  );
  const withoutChannelLanguage = scoreJob(
    'Channel Account Manager',
    'Own the region and hit the number. Report on results each quarter.',
  );
  assert.ok(
    withChannelLanguage.score > withoutChannelLanguage.score,
    `channel language (${withChannelLanguage.score}) must beat generic copy (${withoutChannelLanguage.score})`,
  );
});

test('partner-recruitment language does not trip the hunter cap on channel roles', () => {
  // 4.3: channel postings routinely say "recruit new partners" / "partner
  // acquisition". That reads like hunting vocabulary but must not sink an
  // otherwise-correct role.
  const result = scoreJob(
    'Channel Account Manager',
    [
      'Recruit new partners into the channel partner program and drive partner acquisition.',
      'Own joint business planning, deal registration, and sell-through with authorized resellers.',
      'Manage the existing distributor network and grow the installed base.',
    ].join(' '),
  );
  assert.ok(result.score >= 70, `channel role with partner-recruitment language scored ${result.score}`);
  assert.notEqual(result.category, 'rejected');
});
