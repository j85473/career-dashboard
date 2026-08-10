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
