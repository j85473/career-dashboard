import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPostedTravel } from '../postedTravel';

test('extracts a stated travel percentage in either word order', () => {
  assert.equal(extractPostedTravel('This role requires up to 50% travel.'), 'up to 50%');
  assert.equal(extractPostedTravel('Travel requirement: 25%'), '25%');
  assert.equal(extractPostedTravel('Ability to travel approximately 30% of the time.'), 'approximately 30%');
  assert.equal(extractPostedTravel('Expect 10% overnight travel to customer sites.'), '10%');
});

test('normalizes stated ranges and collapses a redundant one', () => {
  assert.equal(extractPostedTravel('Travel is 25-30% depending on territory.'), '25–30%');
  assert.equal(extractPostedTravel('This position involves 40% – 60% travel.'), '40–60%');
  assert.equal(extractPostedTravel('Travel 20% - 20% annually.'), '20%');
});

test('accepts unambiguous qualitative statements only', () => {
  assert.equal(extractPostedTravel('No travel required for this position.'), 'none stated');
  assert.equal(extractPostedTravel('Travel is not required.'), 'none stated');
  assert.equal(extractPostedTravel('Minimal travel expected.'), 'minimal');
  // Hedged wording is not a commitment and must not be presented as one.
  assert.equal(extractPostedTravel('Some travel may be required.'), null);
  assert.equal(extractPostedTravel('Travel could be required from time to time.'), null);
});

test('infers nothing from a posting that merely implies travel', () => {
  assert.equal(extractPostedTravel('You will support customers across the upper midwest.'), null);
  assert.equal(extractPostedTravel('This is a field-based role.'), null);
  assert.equal(extractPostedTravel(''), null);
  assert.equal(extractPostedTravel(null), null);
});

test('ignores percentages that belong to benefits rather than the travel load', () => {
  assert.equal(extractPostedTravel('We reimburse 100% of travel expenses.'), null);
  assert.equal(extractPostedTravel('Travel mileage reimbursed at 100% of the federal rate.'), null);
  assert.equal(extractPostedTravel('401k with 50% match; travel to conferences encouraged.'), null);
});

test('a benefits sentence elsewhere does not suppress a real travel statement', () => {
  const description = [
    'This role requires up to 40% travel.',
    'We reimburse 100% of travel expenses.',
  ].join(' ');

  assert.equal(extractPostedTravel(description), 'up to 40%');
});

test('prefers a quantified figure over a qualitative one but fails closed on two numbers', () => {
  assert.equal(
    extractPostedTravel('Minimal travel expected. Travel is approximately 15% of the time.'),
    'approximately 15%',
  );
  const conflicting = [
    'Travel up to 25% for the central territory.',
    'Travel up to 60% for the national accounts territory.',
  ].join(' ');
  assert.equal(extractPostedTravel(conflicting), null);
});

test('rejects impossible percentages instead of reporting them', () => {
  assert.equal(extractPostedTravel('Travel 250% of the time.'), null);
  assert.equal(extractPostedTravel('Travel 60-40% of the time.'), null);
});
