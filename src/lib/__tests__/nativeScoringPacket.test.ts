import assert from 'node:assert/strict';
import test from 'node:test';

import { extractMandatoryRequirementCandidates } from '../mandatoryRequirements';
import {
  assertNativeScoringEvaluationPacket,
  buildNativeScoringEvaluationPacket,
  extractExplicitCompensation,
  extractTravelRange,
} from '../nativeScoringPacket';

function packet(description: string, overrides: Partial<{ title: string; company: string; location: string }> = {}): string {
  return buildNativeScoringEvaluationPacket({
    title: overrides.title || 'Channel Territory Manager',
    company: overrides.company || 'Example',
    location: overrides.location || 'US Remote',
    description,
  });
}

test('ButterflyMX posting keeps ordered duties, required experience, travel, and pay while stripping benefits and EEOC text', () => {
  const result = packet(`OUR MISSION:
ButterflyMX is on a mission to empower people to automate property access.
ROLE OVERVIEW
We're seeking a Channel Territory Manager to own and grow the integrator and reseller partner network across the Western territory.
RESPONSIBILITIES
- Own and grow partner relationships across all tiers.
- Build joint business plans and run quarterly business reviews.
- Travel in-territory to partner offices and regional trade shows. Roughly 50%.
REQUIRED EXPERIENCE
- 3+ years in a quota-carrying channel sales, partner management, or business development role.
- Track record of building and growing partner relationships.
- Fluency in Salesforce, Excel, and standard business software.
- Willing to travel approximately 50% of the time in-territory.
COMPENSATION
The expected base salary range is $90,000 - $100,000.
BENEFITS
Comprehensive Medical, Dental and Vision plans and a 401(k) match.
ButterflyMX is an equal opportunity employer. You must have authorization to work in the US.` , {
    company: 'ButterflyMX',
  });

  assert.doesNotThrow(() => assertNativeScoringEvaluationPacket(result));
  assert.match(result, /Own and grow partner relationships[\s\S]*Build joint business plans/);
  assert.match(result, /3\+ years[\s\S]*Track record[\s\S]*Fluency in Salesforce/);
  assert.match(result, /Roughly 50%/);
  assert.match(result, /\$90,000 - \$100,000/);
  assert.doesNotMatch(result, /401|Medical, Dental|equal opportunity|authorization to work/i);
});

test('Radformation posting keeps required and preferred experience in order while stripping mission, hiring, benefits, and diversity copy', () => {
  const result = packet(`About Radformation
Radformation specializes in Radiation Oncology workflow automation. We are a mission-driven team.
Why This Role Matters
The International Sales Channel & Partner Manager will manage and optimize the global distribution network.
Responsibilities Include
- Manage a portfolio of 40+ distributors with EMEA, LATAM and APAC Regional Sales Directors.
- Lead distributor contracting, renewals, onboarding, certification and enablement.
- Develop and lead the distributor certification program.
Required Experience:
- Bachelor’s degree in business or equivalent practical experience.
- 5+ years experience in partner management, reseller management, or equivalent in a global environment.
- Demonstrated experience negotiating and managing commercial contracts across multiple jurisdictions.
Preferred Experience:
- 5+ years experience in a SaaS based software company.
- Experience in Radiation Oncology.
Abilities
- Ability to travel up to 40% of the time.
AI & Hiring Integrity
Complete interviews without tools that generate answers.
Benefits & Perks
Base salary: $100,000-$110,000 USD
On-target earnings (OTE): $200,000-$220,000 USD
Health insurance, 401(k), unlimited PTO and paid parental leave.
Our Commitment to Diversity
Radformation is an equal opportunity workplace.`, {
    title: 'International Channel & Partner Manager',
    company: 'Radformation',
    location: 'Anywhere',
  });

  assert.match(result, /Manage a portfolio[\s\S]*Lead distributor contracting[\s\S]*Develop and lead/);
  assert.match(result, /5\+ years experience in partner management[\s\S]*Demonstrated experience/);
  assert.match(result, /5\+ years experience in a SaaS[\s\S]*Experience in Radiation Oncology/);
  assert.match(result, /40%/);
  assert.match(result, /\$100,000-\$110,000 USD[\s\S]*\$200,000-\$220,000 USD/);
  assert.doesNotMatch(result, /mission-driven|interviews without tools|health insurance|equal opportunity/i);
});

test('Carrier-style HTML decomposes mixed experience, driver, and travel requirements without losing Experience or travel', () => {
  const result = packet(`<strong>Responsibilities</strong><ul><li>Manage distributor relationships and grow regional sales.</li><li>Build account plans and coach partners on execution.</li></ul><strong>Required Qualifications</strong><ul><li>5+ years of Manufacturing or Distribution Sales Experience.</li><li>Valid Driver’s license.</li><li>Ability to travel up to 70%.</li></ul><strong>Preferred Qualifications</strong><ul><li>Bachelor’s Degree.</li><li>HVAC Sales Experience.</li></ul>`, {
    company: 'Carrier',
    title: 'Regional Sales Manager',
  });

  assert.match(result, /5\+ years of Manufacturing or Distribution Sales Experience/);
  assert.match(result, /Ability to travel up to 70%/);
  assert.doesNotMatch(result, /Driver/);
  const requirements = extractMandatoryRequirementCandidates(result, 'Regional Sales Manager').map((candidate) => candidate.text);
  assert.deepEqual(requirements, [
    '5+ years of Manufacturing or Distribution Sales Experience',
    'Bachelor’s Degree',
    'HVAC Sales Experience',
  ]);
  assert.deepEqual(
    extractMandatoryRequirementCandidates(result, 'Regional Sales Manager').map((candidate) => candidate.classification),
    ['required', 'preferred', 'preferred'],
  );
});

test('mixed business-experience and driver sentence retains its experience clauses only', () => {
  const result = packet(`RESPONSIBILITIES
- Manage assigned B2B accounts and grow partner revenue.
- Build quarterly account plans with distributor owners.
REQUIRED EXPERIENCE
- Required: 2-3 years of business experience, a valid driver license, and B2B sales experience.
PREFERRED EXPERIENCE
- CRM experience preferred.`);

  assert.match(result, /2-3 years of business experience[\s\S]*B2B sales experience/);
  assert.doesNotMatch(result, /driver license/i);
  assert.deepEqual(
    extractMandatoryRequirementCandidates(result, 'Channel Territory Manager').map((candidate) => candidate.text),
    ['Required: 2-3 years of business experience', 'B2B sales experience', 'CRM experience preferred'],
  );
});

test('work authorization, background, physical boilerplate, page debris, and cookie text never reach the packet', () => {
  const result = packet(`Cookie preferences
Accept all cookies. Navigation. Search jobs. Related jobs.
RESPONSIBILITIES
- Own customer renewals and coordinate executive business reviews.
- Analyze account health and deliver retention plans.
REQUIRED QUALIFICATIONS
- 4+ years of customer success or account management experience.
- Applicants must be legally authorized to work in the United States.
- Must pass a background check and drug screen.
- Ability to lift 50 pounds with or without reasonable accommodation.
Privacy Notice
Personal data may be processed during the application process.`);

  assert.match(result, /4\+ years of customer success/);
  assert.doesNotMatch(result, /cookie|navigation|related jobs|authorized|background check|drug screen|lift 50|privacy|personal data/i);
});

test('Taylor posting headings preserve real duties and qualifications while removing FISMA background eligibility', () => {
  const result = packet(`Your Opportunity:
Venture Solutions is looking for an onsite Account Manager in Arden Hills, MN.
This location adheres to FISMA. All employees must undergo a federal background check, which requires U.S. citizenship.
Your Responsibilities:
- Daily Account Management Process: communicate with the plant, client and sales regarding project information.
- Customer Relationship Process: understand the client business and identify account growth opportunities.
- Process Improvement: identify opportunities and change processes to improve account profitability.
You Must Have:
- High School Diploma.
- Three or more years’ experience in related customer service positions.
- Examples of successful account management in a service related business.
- Excellent organizational and time management skills.
The anticipated annual salary range is $60,000 - $70,000.
Taylor Corporation is an equal opportunity employer.`, {
    title: 'Account Manager',
    company: 'Taylor',
    location: 'Arden Hills, MN',
  });

  assert.match(result, /Daily Account Management Process[\s\S]*Customer Relationship Process[\s\S]*Process Improvement/);
  assert.match(result, /Three or more years’ experience[\s\S]*successful account management[\s\S]*organizational and time management/);
  assert.match(result, /\$60,000 - \$70,000/);
  assert.doesNotMatch(result, /FISMA|background check|citizenship|equal opportunity/i);
});

test('role-defining RN credential is an explicit verification item, not Experience or an invented candidate fact', () => {
  const result = packet(`RESPONSIBILITIES
- Manage health-system accounts and coordinate clinical stakeholders.
- Lead renewals and expansion planning across the assigned portfolio.
REQUIRED EXPERIENCE
- 5+ years of enterprise account management experience.
- Active Registered Nurse (RN) license required.
- Must be authorized to work in the U.S. and pass a background check.
COMPENSATION
- Pay Range: $108,000 – $151,000.
- Other compensation: Bonus Eligible.`, {
    company: 'MCG Health',
    title: 'Senior Account Executive',
  });

  assert.match(result, /REQUIRED EXPERIENCE[\s\S]*5\+ years of enterprise account management experience/);
  assert.match(result, /ROLE-DEFINING QUALIFICATIONS[\s\S]*Required verification item: Active Registered Nurse \(RN\) license required/);
  assert.match(result, /COMPENSATION[\s\S]*\$108,000 – \$151,000[\s\S]*Bonus Eligible/);
  assert.doesNotMatch(result, /authorized to work|background check/i);
});

test('sanitization is deterministic and raw boilerplate cannot affect the packet hash input', () => {
  const core = `RESPONSIBILITIES
- Own distributor relationships and lead quarterly business reviews.
- Grow revenue through partner enablement and account planning.
REQUIRED EXPERIENCE
- 5+ years of channel sales experience.`;
  const first = packet(`${core}\nBENEFITS\nMedical, dental, 401(k), PTO.`);
  const second = packet(`${core}\nEQUAL OPPORTUNITY\nWe are an affirmative action and equal opportunity employer.`);
  assert.equal(first, second);
});

test('production Accenture compensation and career-development copy cannot inherit preferred experience', () => {
  const result = packet(`RESPONSIBILITIES
- Develop and execute joint growth strategies with Microsoft.
- Build executive relationships and originate enterprise opportunities.
REQUIRED QUALIFICATIONS
- Minimum 8 years of business development or alliance experience.
PREFERRED QUALIFICATIONS
- Experience selling Microsoft Copilot and Fabric offerings.
- Compensation at Accenture varies depending on a wide array of factors, including the specific office location, role, skill set, and level of experience.
- We also provide opportunities to keep skills relevant through certifications, learning, and diverse work experiences.
COMPENSATION
- Minnesota $132,500 to $261,300 USD Annual.`, {
    company: 'Accenture',
  });

  assert.match(result, /PREFERRED EXPERIENCE[\s\S]*Experience selling Microsoft Copilot/);
  assert.match(result, /COMPENSATION[\s\S]*Minnesota \$132,500 to \$261,300 USD Annual/);
  assert.doesNotMatch(result, /varies depending|specific office location|keep skills relevant|diverse work experiences/i);
  assert.doesNotThrow(() => assertNativeScoringEvaluationPacket(result));
});

test('production Workday compensation, culture, and inclusive-hiring fragments cannot inherit required experience', () => {
  const result = packet(`RESPONSIBILITIES
- Initiate and run complex enterprise sales cycles.
- Lead negotiations and closing plans with prospective accounts.
REQUIRED QUALIFICATIONS
- 8+ years of professional experience in software sales.
- Strong organization and communication skills.
- compensation offer will be based on multiple factors including geography, experience, skills, job duties, and business need, among other things.
- Our approach enables our teams to deepen connections, maintain a strong community, and do their best work.
- At Workday, we are committed to providing an accessible and inclusive hiring experience where all candidates can fully demonstrate their skills.
- compensation will be determined commensurate with demonstrated experience.
COMPENSATION
- Primary Location Base Pay Range: $141,000 USD - $211,500 USD.`, {
    company: 'Apex Systems',
  });

  assert.match(result, /REQUIRED EXPERIENCE[\s\S]*8\+ years[\s\S]*Strong organization/);
  assert.match(result, /COMPENSATION[\s\S]*\$141,000 USD - \$211,500 USD/);
  assert.doesNotMatch(result, /compensation offer|determined commensurate|business need|deepen connections|inclusive hiring|fully demonstrate/i);
  assert.doesNotThrow(() => assertNativeScoringEvaluationPacket(result));
});

test('work-arrangement eligibility is retained as location context but never becomes Experience', () => {
  const result = packet(`RESPONSIBILITIES
- Manage assigned customer accounts and renewals.
- Prepare customer quotes and expansion plans.
REQUIRED EXPERIENCE
- 2+ years of account management experience.
PREFERRED EXPERIENCE
- Ability to work primarily on-site in an office setting.`);

  assert.match(result, /WORK LOCATION AND TRAVEL[\s\S]*Ability to work primarily on-site/);
  assert.doesNotMatch(result, /PREFERRED EXPERIENCE[\s\S]*Ability to work primarily on-site/);
  assert.deepEqual(
    extractMandatoryRequirementCandidates(result, 'Channel Territory Manager').map((candidate) => candidate.text),
    ['2+ years of account management experience'],
  );
});

test('collapsed Corteva qualifications split before benefits and retain real degree and tenure requirements', () => {
  const result = packet(`RESPONSIBILITIES
Build and maintain relationships with retail accounts.
Develop retail account plans and educate retailers.
What You'll Need: Minimum of bachelor’s degree is highly preferred, in the following areas: Ag Science, Biology, Agronomy, Business/ Economics Minimum two to five (2-5) years of marketing and/or sales experience Previous sales experience and knowledge of the crop protection market are desirable Ability to pass a driving record background check Keep in mind, equivalent amounts of relevant experience may be considered in lieu of the above requirements Visa sponsorship and International Relocation are NOT available for this position. Benefits – How We’ll Support You: Numerous development opportunities offered to build your skills Health benefits for you and your family Tuition reimbursement program.`);

  assert.match(result, /PREFERRED EXPERIENCE[\s\S]*bachelor’s degree[\s\S]*Previous sales experience/);
  assert.match(result, /REQUIRED EXPERIENCE[\s\S]*Minimum two to five \(2-5\) years/);
  assert.doesNotMatch(result, /driving record|equivalent amounts|Visa sponsorship|Benefits|development opportunities|Health benefits|tuition/i);
  assert.doesNotThrow(() => assertNativeScoringEvaluationPacket(result));
});

test('Alkami-style short headings stop pay-transparency and culture copy from inheriting preferred experience', () => {
  const result = packet(`Essential Duties & Responsibilities
- Act as the primary consultative partner for an assigned book of business.
- Lead strategy discussions and connect platform activity to client ROI.
Required
- 5-7+ years of relevant experience in Client Success or Account Management.
- Proficiency using Customer Success and CRM tools.
Preferred
- Preferred experience working with financial institutions or digital banking.
The salary range for this position is: $102,000 - $114,000
Cool Things to Know
Not Just Any Company: We have a fun culture and offer great benefits.
Work Authorization: Candidates must be eligible to work in the US.
Recruiters: We are not looking for outside recruiting firms.
Pay Transparency: New states and locales have enacted pay equity laws requiring more transparency by employers.
The Important Stuff
We are an Equal Opportunity Employer and prohibit discrimination and harassment.`, {
    title: 'Sr. Client Success Manager I, Data & Marketing',
    company: 'Alkami',
  });

  assert.match(result, /REQUIRED EXPERIENCE[\s\S]*5-7\+ years of relevant experience[\s\S]*Proficiency using Customer Success/);
  assert.match(result, /PREFERRED EXPERIENCE[\s\S]*Preferred experience working with financial institutions/);
  assert.match(result, /COMPENSATION[\s\S]*\$102,000 - \$114,000/);
  assert.doesNotMatch(result, /fun culture|benefits|Work Authorization|Recruiters|Pay Transparency|pay equity|Equal Opportunity|discrimination/i);
  assert.doesNotThrow(() => assertNativeScoringEvaluationPacket(result));
});

test('Western National-style post-qualification sections cannot become requirements', () => {
  const result = packet(`Who are we?
Western National is known as The Relationship Company and has served customers for over 120 years.
What are the responsibilities and opportunities of this role?
Build Relationships & Grow Your Territory
- Build trusted relationships with agency principals, producers, and staff.
- Develop business plans that drive sustainable, profitable growth.
Own Your Territory
- Manage the territory by analyzing production, profitability, and market trends.
Requirements:
Must-Have Qualifications
- 2+ years of property-and-casualty insurance company sales or agency-facing experience.
- Valid and unrestricted driver's license and an acceptable driving record.
What will our ideal candidate have?
- CIC or CPCU designation or insurance-related continuing education.
- Deep knowledge of property-and-casualty insurance products and services.
What Success Looks Like
After your first year, successful Territory Sales Managers are viewed as trusted advisors.
- Representing our values by delivering an exceptional agency experience.
Compensation overview
The targeted hiring range for this role is $93,100-$128,000 annually. However, base pay may vary based on credentials and location.
Culture and Total Rewards
Our employees are our biggest asset. We are consistently recognized as a top workplace.
- Medical insurance, 401(k), paid time off, tuition reimbursement, and parental leave.`, {
    title: 'Territory Sales Manager - Minnesota',
    company: 'Western National',
    location: 'Edina, MN',
  });

  assert.match(result, /CORE RESPONSIBILITIES[\s\S]*Build trusted relationships[\s\S]*Develop business plans[\s\S]*Manage the territory/);
  assert.match(result, /REQUIRED EXPERIENCE[\s\S]*2\+ years of property-and-casualty/);
  assert.match(result, /PREFERRED EXPERIENCE[\s\S]*CIC or CPCU[\s\S]*Deep knowledge/);
  assert.match(result, /COMPENSATION[\s\S]*\$93,100-\$128,000/);
  assert.doesNotMatch(result, /driver|After your first year|Representing our values|employees are our biggest asset|top workplace|Medical insurance|401\(k\)|tuition reimbursement/i);
  assert.doesNotThrow(() => assertNativeScoringEvaluationPacket(result));
});

test('sanitizer fails closed when core duties or qualifications cannot be identified', () => {
  assert.throws(() => packet('Cookie preferences. Sign in to apply. Search jobs. Related jobs.'), /no reliably identified core responsibilities/);
  assert.throws(() => packet('RESPONSIBILITIES\n- Manage partner accounts and grow revenue.'), /no reliably identified experience or qualifications/);
});

test('travel extraction is deterministic for absent, point, range, maximum, minimum, and qualitative language', () => {
  const withTravel = (travel: string | null) => packet(`RESPONSIBILITIES
- Manage distributor relationships and grow regional sales.
REQUIRED EXPERIENCE
- 3+ years of channel sales experience.
${travel ? `TRAVEL\n- ${travel}` : ''}`);

  assert.deepEqual(extractTravelRange(withTravel(null)), {
    kind: 'none', minimumPercent: 0, maximumPercent: 0, label: '0%', sourceText: null,
  });
  assert.equal(extractTravelRange(withTravel('Travel is 50%.')).kind, 'point');
  assert.deepEqual(extractTravelRange(withTravel('Travel is 50-75%.')), {
    kind: 'range', minimumPercent: 50, maximumPercent: 75, label: '50-75%', sourceText: 'Travel is 50-75%',
  });
  assert.equal(extractTravelRange(withTravel('Travel up to 50%.')).kind, 'maximum');
  assert.equal(extractTravelRange(withTravel('Travel at least 50%.')).kind, 'minimum');
  const qualitative = extractTravelRange(withTravel('Quarterly overnight travel is required.'));
  assert.equal(qualitative.kind, 'qualitative');
  assert.match(qualitative.label, /Quarterly overnight travel/);

  const quantitativeAfterQualitative = packet(`RESPONSIBILITIES
- Manage distributor relationships and grow regional sales.
- Travel in-territory for partner meetings and trade shows.
REQUIRED EXPERIENCE
- 3+ years of channel sales experience.
TRAVEL
- Roughly 50% travel.`);
  assert.deepEqual(extractTravelRange(quantitativeAfterQualitative), {
    kind: 'point', minimumPercent: 50, maximumPercent: 50, label: '50%', sourceText: 'Roughly 50% travel',
  });
});

test('explicit compensation is projected from the packet and unstated compensation remains null', () => {
  const stated = packet(`RESPONSIBILITIES
- Manage distributor relationships and grow regional sales.
REQUIRED EXPERIENCE
- 3+ years of channel sales experience.
COMPENSATION
- Base salary: $100,000-$120,000 plus commission.`);
  const unstated = packet(`RESPONSIBILITIES
- Manage distributor relationships and grow regional sales.
REQUIRED EXPERIENCE
- 3+ years of channel sales experience.`);
  assert.match(extractExplicitCompensation(stated) || '', /\$100,000-\$120,000/);
  assert.match(extractExplicitCompensation(stated) || '', /plus commission/i);
  assert.equal(extractExplicitCompensation(unstated), null);
});

test('compensation preserves base, OTE, currency, period, geography, bonus, and commission context', () => {
  const result = packet(`RESPONSIBILITIES
- Manage distributor relationships and grow regional sales.
REQUIRED EXPERIENCE
- 3+ years of channel sales experience.
COMPENSATION
San Francisco Bay Area
- Base salary $120,000-$140,000 USD annually plus commission.
Other US Locations
- Base salary $100,000-$120,000 USD annually; OTE $180,000-$220,000 USD.
- Bonus eligible.`);
  const compensation = extractExplicitCompensation(result) || '';
  assert.match(compensation, /San Francisco Bay Area: Base salary \$120,000-\$140,000 USD annually plus commission/);
  assert.match(compensation, /Other US Locations: Base salary \$100,000-\$120,000 USD annually/);
  assert.match(compensation, /OTE \$180,000-\$220,000 USD/);
  assert.match(compensation, /Bonus eligible/i);
});

test('numeric benefits and pay disclaimers cannot masquerade as compensation facts', () => {
  const result = packet(`RESPONSIBILITIES
- Manage distributor relationships and grow regional sales.
REQUIRED EXPERIENCE
- 3+ years of channel sales experience.
COMPENSATION
- Pay Transparency Statement: The base salary range for this role is $80,000 to $100,000 USD annually plus bonus.
- Tuition reimbursement up to $5,250 in the first year.
- Medical, dental, vision, life insurance, and 401(k) benefits.
- The base salary may vary based on experience, role tenure, performance, industry, and location.`);
  const compensation = extractExplicitCompensation(result) || '';
  assert.match(compensation, /base salary range for this role is \$80,000 to \$100,000 USD annually plus bonus/i);
  assert.doesNotMatch(compensation, /5,250|tuition|medical|401\(k\)|may vary based/i);
  assert.doesNotThrow(() => assertNativeScoringEvaluationPacket(result));
});

test('OSV heading placeholders and culture copy cannot manufacture a scorable qualification', () => {
  assert.throws(() => packet(`RESPONSIBILITIES
- Drive complex sales cycles using internal teams.
- Maintain accurate customer, pipeline, and forecast data.
PREFERRED SKILLS
GROW WITH US:
OSV employees enjoy a values-based culture, upward mobility, and professional development with opportunities of all kinds.`), /no reliably identified experience or qualifications/);
});

test('Tandem base-pay variability disclaimer cannot become required Experience', () => {
  const result = packet(`RESPONSIBILITIES
- Manage strategic trade accounts and distributor relationships.
- Develop account plans and analyze sales performance.
REQUIRED EXPERIENCE
- Bachelor’s degree or equivalent education and applicable work experience.
- 8 or more years of successful field sales experience.
- Base pay will vary based on job-related knowledge, skills, experience and may also fluctuate depending on candidate’s location and the overall job market.
COMPENSATION
- The starting base pay range for this position is $130,000 - $161,000 annually.`);

  const criteria = extractMandatoryRequirementCandidates(result, 'Sr Trade Account Manager').map((candidate) => candidate.text);
  assert.deepEqual(criteria, [
    'Bachelor’s degree or equivalent education and applicable work experience',
    '8 or more years of successful field sales experience',
  ]);
  assert.doesNotMatch(result.slice(result.indexOf('REQUIRED EXPERIENCE'), result.indexOf('PREFERRED EXPERIENCE')), /Base pay|fluctuate|candidate’s location/i);
  assert.match(extractExplicitCompensation(result) || '', /\$130,000 - \$161,000 annually/);
});

test('packet assertion independently rejects pay boilerplate or heading placeholders in Experience', () => {
  const valid = packet(`RESPONSIBILITIES
- Manage strategic accounts and distributor relationships.
REQUIRED EXPERIENCE
- 5+ years of account management experience.`);
  assert.throws(
    () => assertNativeScoringEvaluationPacket(valid.replace(
      '- 5+ years of account management experience',
      '- 5+ years of account management experience\n- Base pay will vary based on job-related experience and candidate’s location.',
    )),
    /pay boilerplate in Experience/,
  );
  assert.throws(
    () => assertNativeScoringEvaluationPacket(valid.replace('- 5+ years of account management experience', '- Preferred Skills')),
    /qualification-heading placeholder/,
  );
});

test('a pay disclaimer split across clauses is excluded by its unfragmented parent line', () => {
  // Verbatim from run db8b417c chunk_0016 job f6502fa3, where clause splitting
  // turned one disclaimer into two "requirements" that no phrase pattern could
  // match on its own, and both reached Agy as mandatory criteria.
  const candidates = extractMandatoryRequirementCandidates(packet(`RESPONSIBILITIES
- Manage ongoing carrier and client relationships across the assigned book.
- Interpret performance metrics and drive corrective action with partners.
REQUIRED EXPERIENCE
- 2-5 years of experience in Account Management or a related client-facing role
- The actual base pay offered will depend on various factors including individual skills, experience, performance, qualifications, the department budget, and the location where work is performed
- Proficiency with Microsoft Office Suite (Excel, Word, PowerPoint)`), 'Carrier Account Manager');
  const texts = candidates.map((candidate) => candidate.text);
  assert.ok(texts.some((text) => /Account Management/.test(text)), 'real requirements survive');
  assert.ok(texts.some((text) => /Microsoft Office Suite/.test(text)), 'real requirements survive');
  assert.equal(texts.some((text) => /base pay/i.test(text)), false, 'first half of the disclaimer is excluded');
  assert.equal(
    texts.some((text) => /department budget|where work is performed/i.test(text)),
    false,
    'trailing fragment of the same sentence is excluded with its parent',
  );
});

test('near-miss pay-disclaimer wordings and leaked headings never become criteria', () => {
  const wordings = [
    // chunk_0009 req-7d2555a3f274eb3baa2e47fe, named by the evaluator directly.
    'Actual base pay within this range will be based on a variety of factors, including but not limited to the applicant’s geographic location, relevant experience, education, skills and licenses/certifications',
    // chunk_0006 / chunk_0011.
    'The starting salary will be determined based on skills',
    'Our goal is to build a strong culture of connection as we work together to empower the restaurant community',
    'What will help you stand out (Nonessential Skills/Nice to Haves)',
  ];
  for (const wording of wordings) {
    const candidates = extractMandatoryRequirementCandidates(packet(`RESPONSIBILITIES
- Manage distributor partner relationships and grow regional sell-through.
- Run joint business planning reviews with partner leadership.
REQUIRED EXPERIENCE
- 5+ years of channel sales experience
- ${wording}`), 'Channel Manager');
    assert.deepEqual(
      candidates.map((candidate) => candidate.text),
      ['5+ years of channel sales experience'],
      `"${wording.slice(0, 48)}..." must not become a criterion`,
    );
  }
});

test('a bare section label is not a requirement and leaves a shell packet with no real criteria', () => {
  // The verbatim packet built for run db8b417c chunk_0005 job 6cd86c84, whose
  // entire qualification list was the heading "Preferred Skills". The evaluator
  // refused this chunk for lacking real qualifications to decompose; extraction
  // must reach the same verdict deterministically rather than fall back to the
  // synthetic core-function criterion and grade an unstated requirement.
  const shellPacket = `ROLE
- Title: Account Executive - Customer Base
- Company: Example

WORK LOCATION AND TRAVEL
- Posted location: US-Remote

CORE RESPONSIBILITIES
- Drive complex sales cycles to closure utilizing internal teams
- Maintain accurate and timely customer, pipeline, and forecast data

REQUIRED EXPERIENCE
- Not stated

PREFERRED EXPERIENCE
- Preferred Skills

ROLE-DEFINING QUALIFICATIONS
- Not stated

COMPENSATION
- Not stated`;
  const candidates = extractMandatoryRequirementCandidates(shellPacket, 'Account Executive');
  assert.deepEqual(candidates.map((candidate) => candidate.source), ['core_function']);
});

test('benefits copy and concatenated contact footers never reach criteria', () => {
  // All three refused their chunks in run db8b417c: benefits phrasing that the
  // comma variant let through (0015), a perk block (0015), and a posting footer
  // concatenated into the qualifications section without separators (0013).
  const wordings = [
    'Excellent medical with Rx, dental, and vision benefits',
    'RECHARGE PROGRAM (after 3 years, disconnect for 3 weeks, no email/slack)',
    'Territory Sales Manager – Pavement Equipment12325 River Road, North Branch MN 55056Contact: Barb Hartman',
  ];
  for (const wording of wordings) {
    const candidates = extractMandatoryRequirementCandidates(packet(`RESPONSIBILITIES
- Manage distributor partner relationships and grow regional sell-through.
- Run joint business planning reviews with partner leadership.
REQUIRED EXPERIENCE
- 5+ years of channel sales experience
- ${wording}`), 'Channel Manager');
    assert.deepEqual(
      candidates.map((candidate) => candidate.text),
      ['5+ years of channel sales experience'],
      `"${wording.slice(0, 48)}..." must not become a criterion`,
    );
  }
});

test('boilerplate screening does not strip legitimate requirements', () => {
  const candidates = extractMandatoryRequirementCandidates(packet(`RESPONSIBILITIES
- Own distributor partner relationships across a four-state territory.
- Run quarterly business reviews with partner leadership.
REQUIRED EXPERIENCE
- 5+ years of channel or distribution sales experience
- Experience negotiating pay-for-performance partner agreements
- Bachelor's degree in business, marketing, or equivalent experience
- Proficiency with Salesforce and Microsoft Excel`), 'Channel Manager');
  assert.deepEqual(candidates.map((candidate) => candidate.text), [
    '5+ years of channel or distribution sales experience',
    'Experience negotiating pay-for-performance partner agreements',
    "Bachelor's degree in business, marketing, or equivalent experience",
    'Proficiency with Salesforce and Microsoft Excel',
  ]);
});
