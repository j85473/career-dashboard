import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPostedBaseCompensation } from '../postedCompensation';

test('extracts the explicit base pay range from the eHealth-style JD wording', () => {
  const description = [
    'For more information on our total rewards offerings, please visit our career site.',
    'Base Pay Range -$79,800 - $99,800',
  ].join('\n');

  assert.equal(extractPostedBaseCompensation(description), '$79,800–$99,800 base');
});

test('normalizes explicit annual salary and base-compensation ranges', () => {
  assert.equal(
    extractPostedBaseCompensation('The annual salary range for this role is $74000 to $98000 USD.'),
    '$74,000–$98,000 base',
  );
  assert.equal(
    extractPostedBaseCompensation('Base compensation range: $141,000 USD – $211,500 USD.'),
    '$141,000–$211,500 base',
  );
});

test('does not present OTE, total-compensation, bonus, or hourly ranges as posted base salary', () => {
  assert.equal(extractPostedBaseCompensation('OTE range: $150,000 - $200,000.'), null);
  assert.equal(extractPostedBaseCompensation('Total compensation range: $125,000 - $150,000.'), null);
  assert.equal(extractPostedBaseCompensation('Salary range, including commission, is $125,000 - $150,000.'), null);
  assert.equal(extractPostedBaseCompensation('Base pay range is $30 - $35 per hour.'), null);
});

test('fails closed on a range stated for any period other than a year', () => {
  // Real posting (sezzle, Principal Engineer): rendering this as base pay
  // understated a ~$72k-$150k role as "$6,000-$12,500". Rescaling to an annual
  // figure would be inference, so the range is dropped instead.
  assert.equal(
    extractPostedBaseCompensation(
      'The salary range for this role is negotiable, the range being $6,000-$12,500 per month (Gross in USD), based on location.',
    ),
    null,
  );
  assert.equal(extractPostedBaseCompensation('Base pay range: $2,400 - $3,100 biweekly.'), null);
  assert.equal(extractPostedBaseCompensation('Salary range of $1,500 to $1,900 a week.'), null);
  // An explicitly annual range is still accepted.
  assert.equal(
    extractPostedBaseCompensation('The annual base salary range is $120,000 - $150,000 per year.'),
    '$120,000–$150,000 base',
  );
});

test('fails closed when a posting states different location-specific base ranges', () => {
  const description = [
    'Base salary range for Colorado: $80,000 - $100,000.',
    'Base salary range for California: $95,000 - $115,000.',
  ].join(' ');

  assert.equal(extractPostedBaseCompensation(description), null);
});

test('drops a range that cannot credibly be an annual base salary', () => {
  // Real postings. Each states a figure, but none states this role's yearly pay.
  assert.equal(
    extractPostedBaseCompensation('The salary range for this role is $2,800 - $6,000 per month (Gross in USD)'),
    null,
  );
  // No period named at all, and far below any plausible yearly salary.
  assert.equal(
    extractPostedBaseCompensation('Sales roles often incorporate incentive compensation beyond this base pay range. $1,075.00 - $1,750.00 USD'),
    null,
  );
  // Northrop Grumman: technically posted, but its own next sentence calls it a
  // guideline spanning every level, so it is not this role's band.
  assert.equal(
    extractPostedBaseCompensation('Primary Level Salary Range: $16,900.00 - $253,600.00 The above salary range represents a general guideline.'),
    null,
  );
});

test('an explicitly annual range survives the plausibility floor', () => {
  // Real posting (supplyhouse, remote India). Low for the US, correct for the
  // role, and the JD says "per year" outright - so it must not be dropped.
  assert.equal(
    extractPostedBaseCompensation('Location: Remote from India. Base Salary: $10,400 \u2013 $13,000 USD per year'),
    '$10,400\u2013$13,000 base',
  );
  assert.equal(
    extractPostedBaseCompensation('Annual base salary range: $12,000 - $14,500.'),
    '$12,000\u2013$14,500 base',
  );
});


test('extracts Criteria fixed base without mixing variable pay or OTE into the label', () => {
  const description = 'Base: $120,000\nVariable Compensation: $60,000\nOTE: $180,000';
  assert.equal(extractPostedBaseCompensation(description), '$120,000 base');
  assert.equal(extractPostedBaseCompensation(description.replaceAll('\n', ' ')), '$120,000 base');
  assert.equal(extractPostedBaseCompensation('The base salary for this position is $120,000 plus variable compensation.'), '$120,000 base');
  assert.equal(extractPostedBaseCompensation('$130,000 base salary ($170,000 OTE)'), '$130,000 base');
});

test('reads common explicit salary formats from affected saved postings', () => {
  for (const [description, expected] of [
    ['Base Salary: $70,000-100,000', '$70,000–$100,000 base'],
    ['Base Salary: $80-85K/year base', '$80,000–$85,000 base'],
    ['Base Salary: $70-80,000 per year, depending upon experience.', '$70,000–$80,000 base'],
    ['The US national base salary range for this position is $140K-223K.', '$140,000–$223,000 base'],
    ['The salary for this role is between $85,000 and $95,000 annually.', '$85,000–$95,000 base'],
    ['Salary: $81,828.00 to $109,823.00 per year', '$81,828.00–$109,823.00 base'],
    ['The estimated base salary range is USD$99,000.00 - USD$121,000.00 per year.', '$99,000.00–$121,000.00 base'],
    ['Salary Range: $88,000–$132,000 base + Commission', '$88,000–$132,000 base'],
    ['Salary range: $75,000 - $95,000, plus equity and an annual bonus.', '$75,000–$95,000 base'],
    ['Salary Range: $120,000 - $130,000. Plus Commission', '$120,000–$130,000 base'],
    ['The base salary range for this role is $92,000 per year.', '$92,000 base'],
    ['$85,000 USD base salary', '$85,000 base'],
  ]) assert.equal(extractPostedBaseCompensation(description), expected, description);
});

test('binds base pay to its own amount when total and variable ranges are nearby', () => {
  assert.equal(extractPostedBaseCompensation('Base salary range: $100,000-$110,000, with OTE for this role: $120,000-$130,000'), '$100,000–$110,000 base');
  assert.equal(extractPostedBaseCompensation('Total Target Cash Pay Range: $112,500 - $202,900, inclusive of target incentives\nBase Pay Range: $78,750 - $142,030'), '$78,750–$142,030 base');
  assert.equal(extractPostedBaseCompensation('Base pay is competitive. OTE: $140,000-$170,000'), null);
  assert.equal(extractPostedBaseCompensation('Base salary plus commissions: $140,000-$170,000 total compensation'), null);
  assert.equal(extractPostedBaseCompensation('Salary range including commission: $125,000-$150,000'), null);
  assert.equal(extractPostedBaseCompensation('Salary: $180,000 OTE'), null);
  assert.equal(extractPostedBaseCompensation('70% base / 30% variable / $215k - $230k OTE'), null);
});

test('does not mislabel limits, foreign currency, nonannual pay, or malformed ranges as fixed salary', () => {
  for (const description of [
    'Base salary: up to $120,000', 'Base salary: $80,000+ DOE',
    'Base salary: $6,000 per month', 'Base pay: $35 per hour',
    'Base salary: CAD$120,000', 'Base salary: $120,000 CAD',
    'Base salary: $120,000 - $100,000', 'Base salary: $120,000 - negotiable',
    'The salary range is either $117,600 or $137,550, depending on experience.',
    'Base salary range: $100,000 - $110,000. Base salary in California: $120,000 - $130,000.',
  ]) assert.equal(extractPostedBaseCompensation(description), null, description);
});


test('reads encoded range separators without taking the first endpoint as fixed salary', () => {
  assert.equal(extractPostedBaseCompensation('Base Salary Range: $163,000 &mdash; $220,000 USD'), '$163,000–$220,000 base');
  assert.equal(extractPostedBaseCompensation('Salary: $80,000 &amp;ndash; $100,000'), '$80,000–$100,000 base');
});

test('does not choose the first city or level in a salary table', () => {
  assert.equal(extractPostedBaseCompensation('Annual Salary Range\nCalifornia $179,200 to $212,800\nCleveland $151,200 to $179,550'), null);
  assert.equal(extractPostedBaseCompensation('Salary ranges estimate for this role is\nZone 1: $111,800 USD - $167,600 USD\nApplicable for CA, CT, NY\nZone 2: $104,500 USD - $156,700 USD'), null);
});

test('ignores a generic salary field that repeats an explicit OTE range', () => {
  assert.equal(extractPostedBaseCompensation('The base salary range for this role is $150,000–$160,000, with an on-target earnings (OTE) range of $300,000–$320,000. Equal opportunity employer. Salary Range $300,000—$320,000 USD'), '$150,000–$160,000 base');
});


test('handles pay periods on both endpoints and escaped markup around a band', () => {
  assert.equal(extractPostedBaseCompensation('Base pay range\n$104,000.00/yr - $156,000.00/yr'), '$104,000.00–$156,000.00 base');
  assert.equal(extractPostedBaseCompensation('Base salary: &lt;span&gt;$100,000&lt;/span&gt;&lt;span&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$120,000 USD&lt;/span&gt;'), '$100,000–$120,000 base');
  assert.equal(extractPostedBaseCompensation('Compensation: up to $160,000 base salary + bonus'), null);
  assert.equal(extractPostedBaseCompensation('Base salary: $120,000 TTC + benefits'), null);
  assert.equal(extractPostedBaseCompensation('The pay range is $60000 \\- £140000 per year'), null);
});


test('keeps comma-separated total pay labels from hiding conflicting regional base bands', () => {
  const description = 'Primary Location Base Pay Range: Home based-Illinois $94,100 - $174,700. Total Target Cash Range: $144,900 - $268,900.If performed in Chicago, IL, the base pay range is $98,600 - $183,000, the total target cash range is $151,800 - $281,600.';
  assert.equal(extractPostedBaseCompensation(description), null);
  assert.equal(extractPostedBaseCompensation('The national minimum salary is $110,000 base and benefits.'), null);
});
