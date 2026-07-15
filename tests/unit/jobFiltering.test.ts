import assert from 'node:assert/strict';
import test from 'node:test';
import { passesPreFilter } from '../../src/lib/jobFiltering';

const base = { title: 'Enterprise Account Executive', company: 'Example', description: '', location: '', url: 'https://example.com/job' };

test('keeps unknown and nationally remote jobs for scoring', () => {
  assert.equal(passesPreFilter(base).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'New York, NY', description: 'This is a fully remote role in the United States.' }).passes, true);
  assert.equal(passesPreFilter({ ...base, location: 'United States' }).passes, true);
});

test('rejects clear non-target locations and explicit excluded employment types', () => {
  assert.equal(passesPreFilter({ ...base, location: 'New York, NY' }).passes, false);
  assert.equal(passesPreFilter({ ...base, title: 'Part-Time Sales Representative', location: 'Remote' }).passes, false);
  assert.equal(passesPreFilter({ ...base, title: '1099 Sales Contractor', location: 'Minnesota' }).passes, false);
});
