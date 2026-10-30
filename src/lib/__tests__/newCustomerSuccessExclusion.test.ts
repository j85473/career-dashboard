import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOMER_SUCCESS_EXCLUSION_REASON,
  filterNewCustomerSuccessRole,
  isExcludedCustomerSuccessTitle,
} from '../newCustomerSuccessExclusion';

const intake = {
  id: 'new-job', title: 'Customer Success Manager', status: 'pending_af',
  source: 'ATS-greenhouse', tailoringStaged: false,
  fitScore: null, aimFitScore: null, reqFitScore: null, travelScore: null,
};

test('excludes customer/client success occupations across seniority and title formatting', () => {
  for (const title of [
    'Customer Success Manager', 'Senior Customer Success Manager',
    'Client Success Manager, Scale', 'Director of Customer Success',
    'Head of Client Success', 'Customer Success Associate',
    'Coordinator, Client Success', 'Clinical Customer Success Specialist',
    'Enterprise CSM', 'Go-to-Market Strategist (CSM)',
    'Customer-Success Manager', 'CUSTOMER–SUCCESS LEAD',
    'Customer   Success Manager', 'Customer Success Manager - Channel Partners',
  ]) assert.equal(isExcludedCustomerSuccessTitle(title), true, title);
});

test('keeps partner/channel/distributor and account occupations eligible', () => {
  for (const title of [
    'Partner Success Manager', 'Channel Success Manager', 'Distributor Manager',
    'Distribution Partner Manager', 'Account Manager', 'Strategic Account Director',
    'Principal Partner Success Specialist, ASP Customer Success',
    'Account Manager, Client Success', 'Customer Success Account Manager',
    'Channel Account Manager - Customer Success',
    'Client Services Manager', 'Customer Experience Manager', 'CSMITH Sales Manager',
    'Territory Sales Manager',
  ]) assert.equal(isExcludedCustomerSuccessTitle(title), false, title);
});

test('new CS intake is dismissed with a reason and atomic protection for existing work', async () => {
  let writes = 0;
  const filtered = await filterNewCustomerSuccessRole(intake, 'local:lease', async ({ where, data }) => {
    writes++;
    assert.deepEqual(where, {
      id: intake.id, title: intake.title, status: 'pending_af',
      scoringStatus: 'scoring', batchJobId: 'local:lease', tailoringStaged: false,
      fitScore: null, aimFitScore: null, reqFitScore: null, travelScore: null,
      AND: [{ OR: [{ source: null }, { source: { not: 'Manual Import' } }] }],
      scoreEvents: { none: {} }, scoringArtifacts: { none: {} },
      aimFactualExtractions: { none: {} },
      statusHistory: { none: { status: { not: 'pending_af' } } },
    });
    assert.deepEqual(data, {
      status: 'dismissed', scoringStatus: 'skipped',
      passReason: CUSTOMER_SUCCESS_EXCLUSION_REASON,
      batchJobId: null, scoreAttempts: 0, scoreError: null,
    });
    return { count: 1 };
  });
  assert.equal(filtered, true);
  assert.equal(writes, 1);
});

test('existing scores, Inbox cards, lifecycle decisions and manual selections never reach the writer', async () => {
  for (const patch of [
    { fitScore: 0 }, { fitScore: 85 }, { aimFitScore: 87 }, { reqFitScore: 87 },
    { travelScore: 80 }, { tailoringStaged: true }, { source: 'Manual Import' },
    ...['inbox', 'applied', 'interviewing', 'bookmarked', 'cooldown', 'expired', 'passed', 'dismissed', 'archived']
      .map((status) => ({ status })),
    { title: 'Partner Success Manager' }, { title: 'Account Manager' },
  ]) {
    const filtered = await filterNewCustomerSuccessRole({ ...intake, ...patch }, 'local:lease', async () => {
      assert.fail(`Protected work reached the writer: ${JSON.stringify(patch)}`);
    });
    assert.equal(filtered, false, JSON.stringify(patch));
  }
});

test('a concurrent score, user action or lost lease prevents disposition', async () => {
  assert.equal(await filterNewCustomerSuccessRole(intake, 'local:old-lease', async () => ({ count: 0 })), false);
});
