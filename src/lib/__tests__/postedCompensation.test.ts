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
