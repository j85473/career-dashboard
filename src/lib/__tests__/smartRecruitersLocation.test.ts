import assert from 'node:assert/strict';
import test from 'node:test';
import { smartRecruitersLocation } from '../smartRecruitersLocation';
import { parseBoardPostings, locationsCompatibleForDirectMatch } from '../atsDirectMatch';
import { evaluateAuthoritativeGeography } from '../authoritativeMetadataGate';

const vericast = { city: 'Columbus', region: 'OH', country: 'us', remote: true, hybrid: false,
  fullLocation: 'Columbus, OH, United States' };
const passes = (location: unknown, title = 'Account Executive IV') => evaluateAuthoritativeGeography({
  title, location: smartRecruitersLocation(location),
}).passes;

test('Vericast remote flag survives canonical matching and the automatic geography gate', () => {
  const [posting] = parseBoardPostings('smartrecruiters', { content: [{
    id: '744000159537989', name: 'Account Executive IV', company: { identifier: 'Vericast' }, location: vericast,
  }] }, 'Vericast');
  assert.equal(posting.location, 'Remote - United States; Columbus, OH, United States');
  assert.equal(posting.location, smartRecruitersLocation(vericast));
  assert.equal(locationsCompatibleForDirectMatch('United States', posting.location), true);
  assert.equal(evaluateAuthoritativeGeography({ title: posting.title, location: posting.location }).passes, true);
  assert.equal(passes(vericast, 'Account Executive (must reside in Ohio)'), false);
});

test('remote metadata does not broaden hybrid, onsite, foreign or explicitly restricted locations', () => {
  for (const location of [
    { ...vericast, hybrid: true }, { ...vericast, remote: false }, { ...vericast, remote: 'true' },
    { city: 'Toronto', region: 'ON', country: 'ca', remote: true },
    { ...vericast, fullLocation: 'Columbus, OH (Ohio residents only)' },
    { ...vericast, fullLocation: 'Must reside in Ohio' },
    { ...vericast, fullLocation: 'Ohio' },
    { ...vericast, fullLocation: 'Ohio (Remote)' },
  ]) assert.equal(passes(location), false, JSON.stringify(location));
  assert.equal(passes({ ...vericast, city: 'Minneapolis', region: 'MN', remote: false, fullLocation: '' }), true);
});

test('listing without fullLocation retains country and remote flag without inventing worldwide eligibility', () => {
  assert.equal(smartRecruitersLocation({ ...vericast, fullLocation: undefined }), 'Remote - United States; Columbus, OH, United States');
  assert.equal(smartRecruitersLocation({ remote: true, country: 'ca' }), 'Remote - Canada');
  assert.equal(smartRecruitersLocation({ remote: true }), 'Remote');
  assert.equal(smartRecruitersLocation(null), null);
});
