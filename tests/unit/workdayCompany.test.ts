import assert from 'node:assert/strict';
import test from 'node:test';

import {
  workdayBoardCompanyFallback,
  workdayCompanyDisplayName,
  workdayHiringOrganizationName,
} from '../../src/lib/workdayCompany';

test('reads the exact Workday hiring entity from the real detail-response shape', () => {
  assert.equal(
    workdayHiringOrganizationName({ name: 'Graco High Pressure Equipment Inc.', url: '' }),
    'Graco High Pressure Equipment Inc.',
  );
  assert.equal(
    workdayHiringOrganizationName({ name: '  NBT Bancorp Inc.  ' }),
    'NBT Bancorp Inc.',
  );
});

test('rejects missing, blank, scalar, and array hiring-organization shapes', () => {
  assert.equal(workdayHiringOrganizationName(undefined), null);
  assert.equal(workdayHiringOrganizationName({}), null);
  assert.equal(workdayHiringOrganizationName({ name: '   ' }), null);
  assert.equal(workdayHiringOrganizationName({ name: '100' }), null);
  assert.equal(workdayHiringOrganizationName({ name: 'N/A' }), null);
  assert.equal(workdayHiringOrganizationName('Graco'), null);
  assert.equal(workdayHiringOrganizationName([{ name: 'Graco' }]), null);
});

test('Workday board fallback removes only the infrastructure shard', () => {
  assert.equal(workdayBoardCompanyFallback('graco.wd501::Graco_Careers'), 'Graco');
  assert.equal(workdayBoardCompanyFallback('3m.wd1::Search'), '3M');
  assert.equal(workdayBoardCompanyFallback('acme-industries.wd12::External'), 'Acme Industries');
  // Opaque tenants are not expanded into an invented brand.
  assert.equal(workdayBoardCompanyFallback('bdx.wd1::jobs'), 'Bdx');
});

test('historical Workday hostname labels get a presentation-only tenant fallback', () => {
  assert.equal(workdayCompanyDisplayName('forrester.wd501', 'ATS-workday'), 'Forrester');
  assert.equal(workdayCompanyDisplayName('litera.wd12', 'ATS-workday'), 'Litera');
  assert.equal(workdayCompanyDisplayName('Acme, Inc.', 'ATS-workday'), 'Acme, Inc.');
  assert.equal(workdayCompanyDisplayName('forrester.wd501', 'Adzuna'), 'forrester.wd501');
});
