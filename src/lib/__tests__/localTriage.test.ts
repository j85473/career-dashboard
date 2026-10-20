import assert from 'node:assert/strict';
import test from 'node:test';
import {
  employerTriageVerdict,
  LOCAL_TRIAGE_ENABLED,
  localTriageVerdict,
  locationTriageVerdict,
  titleTriageVerdict,
} from '../localTriage';
import { isExplicitInternationalLocationOption } from '../jobLocationPolicy';

test('triage is enabled by default', () => {
  assert.equal(LOCAL_TRIAGE_ENABLED, true);
});

test('an uncapped role passes title triage', () => {
  const verdict = titleTriageVerdict('');
  assert.equal(verdict.pass, true);
  assert.match(verdict.reason, /discovery metadata only/);
});

test('2020 Companies is excluded by exact known employer aliases', () => {
  for (const company of ['2020 Companies', '  2020   Companies, Inc.  ', '2020companies.wd1']) {
    const verdict = employerTriageVerdict(company);
    assert.equal(verdict.pass, false, company);
    assert.equal(verdict.reason, 'Employer excluded from local scoring (2020 Companies)');
  }
});

test('Goodwill affiliates and ATS labels are excluded with exact normalized employer matching', () => {
  for (const company of [
    'Goodwill',
    'Goodwill Industries - Suncoast Inc',
    'Goodwill Industries - Suncoast',
    '  GOODWILL   Industries - Suncoast Inc  ',
    'Goodwill-Easter Seals Minnesota',
    'Goodwill-Easter Seals of Minnesota',
    'True North Goodwill',
    'True North Goodwill Northern Minnesota and No',
    'Evergreen Goodwill',
    'Goodwill Industries International, Inc.',
    'goodwillaz.wd1',
    'goodwillmiddletn.wd5',
    'GoodwillOfSouthwesternPennsylvan',
    'GulfstreamGoodwillIndustriesInc',
  ]) {
    const verdict = localTriageVerdict({ company, title: 'Sales Manager', location: 'Minneapolis, MN', capRationale: '' });
    assert.equal(verdict.pass, false, company);
    assert.equal(verdict.reason, 'Employer excluded from local scoring (Goodwill)');
  }
  for (const company of ['Agency serving Goodwill', 'Goodwill Consulting Partners', 'Acme Goodwill Services', 'Goodwill Industries - Suncoast Inc Consulting', 'Acme']) {
    assert.equal(employerTriageVerdict(company).pass, true, company);
  }
});

test('Cintas is excluded under its observed employer labels with case and whitespace normalization', () => {
  for (const company of ['Cintas', ' CINTAS ', 'Cintas Corp', 'Cintas Corp.', 'Cintas Corporation', '  Cintas   CORPORATION  ']) {
    const verdict = localTriageVerdict({ company, title: 'Channel Account Manager', location: 'Remote', capRationale: '' });
    assert.equal(verdict.pass, false, company);
    assert.equal(verdict.reason, 'Employer excluded from local scoring (Cintas)');
  }
});

test('the Cintas exclusion does not match unrelated employers or agencies mentioning Cintas', () => {
  for (const company of ['Cintas Consulting Partners', 'Agency serving Cintas', 'Cintas Corporation Staffing', 'Acme Cintas Services', 'Cintas-like Company', 'Acme']) {
    assert.equal(employerTriageVerdict(company).pass, true, company);
  }
});

test('AO Garcia Agency is excluded under both observed employer names without excluding unrelated Garcia employers', () => {
  for (const company of ['Aogarciaagency', 'AO Garcia Agency', '  AO   GARCIA Agency  ']) {
    const verdict = localTriageVerdict({ company, title: 'Channel Account Manager', location: 'Remote', capRationale: '' });
    assert.equal(verdict.pass, false, company);
    assert.equal(verdict.reason, 'Employer excluded from local scoring (AO Garcia Agency)');
  }
  for (const company of ['Garcia Agency', 'AO Garcia Agency Consulting', 'Agency serving AO Garcia Agency', 'AO Globe Life']) {
    assert.equal(employerTriageVerdict(company).pass, true, company);
  }
});

test('the employer exclusion does not match other companies with 2020 in their name', () => {
  for (const company of ['2020 Bayern', '2020 Cubic Transportation Systems, Inc.', 'Logic2020Inc']) {
    assert.equal(employerTriageVerdict(company).pass, true, company);
  }
});

test('Platinum Supplemental Insurance aliases are excluded without rejecting other Platinum employers', () => {
  for (const company of [
    'Platinum Supplemental Insurance',
    'PLATINUM SUPPLEMENTAL INSURANCE',
    'Platinum Supplemental Insurance, Inc.',
    ' Platinum  Supplemental Insurance Inc ',
  ]) {
    const verdict = employerTriageVerdict(company);
    assert.equal(verdict.pass, false, company);
    assert.equal(verdict.reason, 'Employer excluded from local scoring (Platinum Supplemental Insurance)');
  }
  for (const company of ['Platinum Staffing Group', 'Platinum Pest Solutions Inc.', 'ValterraPlatinum1']) {
    assert.equal(employerTriageVerdict(company).pass, true, company);
  }
});

test('Workday is excluded as an employer without excluding companies that use its ATS', () => {
  for (const company of ['Workday', ' WORKDAY ', 'Workday, Inc.', 'Workday Inc']) {
    const verdict = employerTriageVerdict(company);
    assert.equal(verdict.pass, false, company);
    assert.equal(verdict.reason, 'Employer excluded from local scoring (Workday)');
  }
  for (const company of ['Acme', 'Workday Consulting Partners', 'acme.wd1']) {
    assert.equal(employerTriageVerdict(company).pass, true, company);
  }
});

test('an explicit employer exclusion is recorded ahead of title and location triage', () => {
  const verdict = localTriageVerdict({
    capRationale: 'No target sales, account management, partnerships, or customer success title signal; score capped below triage.',
    company: '2020 Companies',
    title: 'Software Engineer - London',
    location: 'London, United Kingdom',
  });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, 'Employer excluded from local scoring (2020 Companies)');
});

test('a capped role is withheld, carrying the cap reason', () => {
  const cap = 'No target sales, account management, partnerships, or customer success title signal; score capped below triage.';
  const verdict = titleTriageVerdict(cap);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, cap);
});

test('locations inside the searched geographies pass', () => {
  for (const location of [
    'Minneapolis, MN',
    'St. Paul, Minnesota',
    'Minnesota',
    'Remote',
    'Remote - United States',
    'United States',
  ]) {
    assert.equal(locationTriageVerdict(location).pass, true, location);
  }
});

test('a location the search lanes never asked for is withheld', () => {
  // Glassdoor returns verified city/state metadata, so a Texas or London role
  // is knowable for free — Aim was paying to reach the same conclusion.
  for (const location of ['Austin, TX', 'Dallas, Texas', 'London, United Kingdom', 'Bengaluru, India']) {
    const verdict = locationTriageVerdict(location);
    assert.equal(verdict.pass, false, location);
    assert.match(verdict.reason, /outside the searched geographies/i);
  }
});

test('a missing location is not treated as a bad location', () => {
  // Absent metadata is not evidence; the JD may still place the role correctly.
  for (const location of [null, undefined, '', '   ']) {
    assert.equal(locationTriageVerdict(location).pass, true, String(location));
  }
});

test('ambiguous field arrangements and coverage regions reach eligibility review', () => {
  for (const location of [
    'Anywhere', 'Anywhere, US', 'Anywhere USA', 'Anywhere in the United States',
    'Field Based', 'Field-Based', 'Field Based - United States',
    'Midwest', 'Upper Midwest', 'Central region', 'Remote - Midwest',
    'Field-Based, Central US; Field-Based, Southeastern US',
    'Midwest, US (Remote, must reside in territory)',
  ]) {
    const verdict = locationTriageVerdict(location);
    assert.equal(verdict.pass, true, `${location}: ${verdict.reason}`);
    assert.match(verdict.reason, /eligibility review/i);
  }
});

test('Minnesota in a multistate coverage list is an eligible option', () => {
  for (const location of [
    'MN, IA, NE', 'Iowa, Minnesota and Wisconsin', 'Remote - MN, IA, NE',
    'Field Based: Iowa, MN and Wisconsin',
    'Remote within the Midwest Region - Ohio, Kentucky, West Virginia, Western Pennsylvania, Michigan, Northern Illinois, Wisconsin, Iowa, Minnesota, North Dakota, and South Dakota',
  ]) {
    const verdict = locationTriageVerdict(location);
    assert.equal(verdict.pass, true, `${location}: ${verdict.reason}`);
    assert.match(verdict.reason, /includes Minnesota/i);
  }
});

test('field location exceptions cannot turn explicit foreign or nonlocal bases into eligibility', () => {
  for (const location of [
    'Field Based Netherlands', 'Field Based UK - FIELD', 'Field Based - Singapore',
    'Field Based, Remote - FL, USA', 'Field Based (LA/Orange County, CA)',
    'MIDWEST OFFICE, LIVONIA - 2797', 'Central Region; Cleveland OH, Cleveland, OH, US',
    'Remote within the Midwest Region - Ohio, Illinois and Wisconsin',
    'Rochester, Minnesota', 'Duluth, MN', 'Minneapolis, Kansas',
    'Must live in Chicago, IL; territory Minnesota, Iowa and Wisconsin',
    'Remote - Midwest (must live in Illinois)', 'Field Based - London; Anywhere',
  ]) assert.equal(locationTriageVerdict(location).pass, false, location);
  assert.equal(localTriageVerdict({ capRationale: '', title: 'Regional Sales Manager - Must live in Illinois', location: 'Midwest' }).pass, false);
});

test('title triage is reported ahead of location when both would reject', () => {
  const cap = 'No target sales, account management, partnerships, or customer success title signal; score capped below triage.';
  const verdict = localTriageVerdict({ capRationale: cap, location: 'Austin, TX' });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, cap);
});

test('a good title in a bad place is still withheld', () => {
  const verdict = localTriageVerdict({ capRationale: '', location: 'Austin, TX' });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /outside the searched geographies/i);
});

test('a good title in a searched place passes', () => {
  assert.equal(localTriageVerdict({ capRationale: '', location: 'Minneapolis, MN' }).pass, true);
});

test('triage never promotes — it only ever withholds', () => {
  // Every verdict is either "pass through unchanged" or "withhold with a
  // reason"; there is no branch that admits something the heuristic rejected.
  const passing = localTriageVerdict({ capRationale: '', location: 'Minnesota' });
  assert.equal(passing.pass, true);
  assert.match(passing.reason, /discovery metadata only/);
});

test('a multi-site posting survives if any option is in scope', () => {
  // Real listing: rejecting on the presence of any out-of-scope option would
  // have discarded a role that is genuinely available in Minneapolis.
  for (const location of [
    'Austin, TX; Eau Claire, WI; Minneapolis, MN',
    'Chicago, IL; Minnesota',
    'Dallas, Texas; Remote',
  ]) {
    assert.equal(locationTriageVerdict(location).pass, true, location);
  }
});

test('a multi-site posting entirely outside scope is still withheld', () => {
  for (const location of ['Austin, TX; Dallas, TX', 'London, United Kingdom; Dublin, Ireland']) {
    assert.equal(locationTriageVerdict(location).pass, false, location);
  }
});

test('an opaque placeholder or bare remote fragment cannot rescue an explicitly foreign site', () => {
  for (const location of [
    'Tijuana, Mexico; 2 Locations',
    'NL Nieuwegein; NL Tilburg; 2 Locations',
    'London, United Kingdom; Remote',
  ]) {
    const verdict = locationTriageVerdict(location);
    assert.equal(verdict.pass, false, location);
    assert.match(verdict.reason, /outside the searched geographies/i);
  }
});

test('explicit US or Minnesota availability still keeps a multi-country posting in scope', () => {
  for (const location of [
    'London, United Kingdom; Remote - United States',
    'NL Nieuwegein; Minneapolis, MN',
  ]) assert.equal(locationTriageVerdict(location).pass, true, location);
});

test('provider remote spelling variants remain in scope', () => {
  for (const location of ['Remote-United-States', 'Remotely based']) {
    assert.equal(locationTriageVerdict(location).pass, true, location);
  }
});

test('worldwide availability reaches review because it does not exclude Minnesota', () => {
  for (const location of ['Remote / Anywhere in the World', 'Remote - Worldwide', 'Anywhere in the World']) {
    const verdict = locationTriageVerdict(location);
    assert.equal(verdict.pass, true, location);
    assert.match(verdict.reason, /eligibility review/i);
  }
});

test('a global-remote role that also lists Minneapolis is kept', () => {
  assert.equal(locationTriageVerdict('Remote / Anywhere in the World; Minneapolis, MN').pass, true);
});

test('a territory in a remote title reaches work-base review', () => {
  for (const title of [
    'Senior Partner Solutions Engineer - APAC',
    'Channel Account Manager, EMEA',
    'Regional Sales Manager - India',
  ]) {
    const verdict = localTriageVerdict({ capRationale: '', title, location: 'Remote' });
    assert.equal(verdict.pass, true, title);
    assert.match(verdict.reason, /discovery metadata only/i);
  }
});

test('a title and unresolved placeholder do not establish a required residence', () => {
  const verdict = localTriageVerdict({
    capRationale: '',
    title: 'Direct Auto Area Sales Manager - Raleigh NC Area',
    location: '2 Locations',
  });
  assert.equal(verdict.pass, true);
});

test('a Minnesota title is never rejected by the territory rule', () => {
  for (const title of ['Channel Manager, Minneapolis', 'Territory Sales Manager - Minnesota']) {
    assert.equal(localTriageVerdict({ capRationale: '', title, location: 'Remote' }).pass, true, title);
  }
});

test('a separate Minneapolis option in a territory title survives geography triage', () => {
  for (const title of [
    'Associate Territory Manager - Montana/Minneapolis',
    'Associate Territory Manager - Minneapolis/Montana',
    'Territory Sales Executive - Wisconsin or Minneapolis',
    'Field Sales Representative - Chicago; Minneapolis',
  ]) {
    const result = localTriageVerdict({ capRationale: '', title, location: 'Minneapolis, MN' });
    assert.equal(result.pass, true, `${title}: ${result.reason}`);
  }
});

test('coverage titles reach review while conflicting work-location metadata remains excluded', () => {
  for (const title of [
    'Associate Territory Manager - Montana/Seattle',
    'Territory Sales Executive - Wisconsin',
    'Territory Sales Manager - Minneapolis, Kansas',
  ]) {
    const result = localTriageVerdict({ capRationale: '', title, location: 'Remote' });
    assert.equal(result.pass, true, title);
  }
  assert.equal(localTriageVerdict({
    capRationale: '', title: 'Territory Manager - Montana/Minneapolis', location: 'Billings, Montana',
  }).pass, false);
});

test('a US location prefixed by a state code is never read as a foreign country', () => {
  // "IN"/"DE" are Indiana and Delaware as often as India and Germany, and
  // Workday emits state-first segments. This predicate feeds an auto-dismiss
  // path that clears scores, so a false positive silently discards a real job.
  // These may still be out of scope for being non-local — they must simply
  // never be out of scope for being *foreign*.
  for (const location of [
    'IN-Indianapolis',
    'DE-Wilmington',
    'IN Bloomington',
    'SE Portland OR',
    'IT Support Center, Dallas TX',
  ]) {
    assert.equal(
      isExplicitInternationalLocationOption(location),
      false,
      `${location} was misread as international`,
    );
  }
});

test('a genuine country-code prefix is still caught', () => {
  // Real ATS metadata: the country code carries the only geographic signal.
  for (const location of ['NL Nieuwegein', 'NL Tilburg', 'PL-Warsaw', 'Remote - SG']) {
    assert.equal(isExplicitInternationalLocationOption(location), true, location);
    assert.equal(locationTriageVerdict(location).pass, false, location);
  }
});

test('a Minnesota option still outranks a foreign one', () => {
  assert.equal(locationTriageVerdict('NL Nieuwegein; Minneapolis, MN').pass, true);
});
