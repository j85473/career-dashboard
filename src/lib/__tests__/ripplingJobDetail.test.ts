import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRipplingJobDetail } from '../jobIngestion';
import { extractStructuredBaseCompensation } from '../postedCompensation';

// Real response shape for ampersandbrands/0a25a6aa-900e-4dc0-bb93-64ad26c7b44c,
// captured 2026-08-19. `description` is an object, not a string — the bug this
// test guards against is `String(description)` silently yielding
// "[object Object]", which sails past the 650-character JD quality gate as
// garbage.
const realDetail = {
  description: {
    company: '<p>Lolli &amp; Pops is a candy company...</p>'.repeat(3),
    role: '<p>We are looking for a Physiothérapeute...</p>'.repeat(8),
  },
  companyName: "Lolli & Pops - Hammond's Candies",
  payRangeDetails: [
    { location: 'Denver, CO', currency: 'USD', frequency: 'YEAR', rangeStart: 70000.0, rangeEnd: 75000.0, isRemote: false },
  ],
  workLocations: ['Denver, CO'],
  employmentType: { label: 'SALARIED_FT', id: 'Salaried, full-time' },
};

test('parseRipplingJobDetail concatenates the {company, role} object rather than stringifying it', () => {
  const parsed = parseRipplingJobDetail(realDetail);
  assert.ok(!parsed.rawDescription.includes('[object Object]'));
  assert.ok(parsed.rawDescription.startsWith(realDetail.description.company));
  assert.ok(parsed.rawDescription.includes(realDetail.description.role));
});

test('parseRipplingJobDetail prefers companyName over the board-slug derivation', () => {
  const parsed = parseRipplingJobDetail(realDetail);
  assert.equal(parsed.company, "Lolli & Pops - Hammond's Candies");
});

test('parseRipplingJobDetail falls back to null company when companyName is absent', () => {
  const parsed = parseRipplingJobDetail({ ...realDetail, companyName: undefined });
  assert.equal(parsed.company, null);
});

test('parseRipplingJobDetail joins workLocations with "; " for splitLocationOptions', () => {
  const parsed = parseRipplingJobDetail({ ...realDetail, workLocations: ['Denver, CO', 'Minneapolis, MN'] });
  assert.equal(parsed.location, 'Denver, CO; Minneapolis, MN');
});

test('parseRipplingJobDetail leaves location null when workLocations is absent', () => {
  const parsed = parseRipplingJobDetail({ ...realDetail, workLocations: undefined });
  assert.equal(parsed.location, null);
});

test('parseRipplingJobDetail reads an unambiguous annual USD range off payRangeDetails', () => {
  const parsed = parseRipplingJobDetail(realDetail);
  assert.equal(parsed.compensation, '$70,000–$75,000 base');
});

test('parseRipplingJobDetail treats a string description as a plain fallback', () => {
  const parsed = parseRipplingJobDetail({ ...realDetail, description: 'Plain text body.' });
  assert.equal(parsed.rawDescription, 'Plain text body.');
});

test('parseRipplingJobDetail is empty-safe when description is missing entirely', () => {
  const parsed = parseRipplingJobDetail({});
  assert.equal(parsed.rawDescription, '');
  assert.equal(parsed.company, null);
  assert.equal(parsed.location, null);
  assert.equal(parsed.compensation, null);
});

test('extractStructuredBaseCompensation drops a range whose currency is not USD', () => {
  assert.equal(
    extractStructuredBaseCompensation([{ currency: 'EUR', frequency: 'YEAR', rangeStart: 70000, rangeEnd: 75000 }]),
    null,
  );
});

test('extractStructuredBaseCompensation drops a range that is not stated as annual', () => {
  // Cannot credibly be annual once the frequency says otherwise — the same
  // rule that makes the prose extractor reject a non-annual period.
  assert.equal(
    extractStructuredBaseCompensation([{ currency: 'USD', frequency: 'MONTH', rangeStart: 6000, rangeEnd: 7000 }]),
    null,
  );
});

test('extractStructuredBaseCompensation fails closed on multiple distinct ranges', () => {
  assert.equal(
    extractStructuredBaseCompensation([
      { currency: 'USD', frequency: 'YEAR', rangeStart: 70000, rangeEnd: 75000 },
      { currency: 'USD', frequency: 'YEAR', rangeStart: 90000, rangeEnd: 95000 },
    ]),
    null,
  );
});

test('extractStructuredBaseCompensation rejects an implausible order-of-magnitude band', () => {
  assert.equal(
    extractStructuredBaseCompensation([{ currency: 'USD', frequency: 'YEAR', rangeStart: 16900, rangeEnd: 253600 }]),
    null,
  );
});

test('extractStructuredBaseCompensation is null for an empty or missing array', () => {
  assert.equal(extractStructuredBaseCompensation(undefined), null);
  assert.equal(extractStructuredBaseCompensation([]), null);
});
