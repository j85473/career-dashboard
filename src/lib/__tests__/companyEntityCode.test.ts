import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Prisma } from '@prisma/client';

import { employerRelation, mayRepeat } from '../appliedRepeatMatch';
import { companyIdentityKey, sameCompanyIdentity, withoutEntityCode } from '../companyIdentity';
import { standardizeIncomingCompany } from '../companyNameStandardization';
import { companyDisplayGroupKey, companyDisplayName } from '../companyPresentation';

// Real Workday hiring-organization names from production (2026-09-18).
const STRIPPED: Array<[string, string]> = [
  ['USA-NILIN Nilfisk, Inc.', 'Nilfisk, Inc.'],
  ['GBR-NILLT Nilfisk Ltd', 'Nilfisk Ltd'],
  ['94-1687665 Bank of America, National Association', 'Bank of America, National Association'],
  ['100 Panera, LLC', 'Panera, LLC'],
  ['LE001 Northwest Bank', 'Northwest Bank'],
  ['CO39 St. Lukes Hospital', 'St. Lukes Hospital'],
  ['CO-06 Patient First Richmond Medical Group, P.L.L.C.', 'Patient First Richmond Medical Group, P.L.L.C.'],
  ['LE001-ASXOPS ASX Operations Pty Ltd', 'ASX Operations Pty Ltd'],
  ['6014-Janssen Biotech, Inc. Legal Entity', 'Janssen Biotech, Inc.'],
  ['001 - Illinois Tool Works Inc.', 'Illinois Tool Works Inc.'],
  ['U014 (FCRS = US014) Novartis Pharmaceuticals Corporation', 'Novartis Pharmaceuticals Corporation'],
  ['B10 Wells Fargo Bank, N. A.', 'Wells Fargo Bank, N. A.'],
  ['USA-GBA Gogo Business Aviation LLC', 'Gogo Business Aviation LLC'],
  ['TDB-SOR Toyota do Brasil Ltda (Sorocaba) Company', 'Toyota do Brasil Ltda (Sorocaba) Company'],
  ['PDM-110 Productos Medline S.A. de C.V.', 'Productos Medline S.A. de C.V.'],
];

// The code carries the identity, or the name is a brand that starts with a
// number or code. These must come back unchanged.
const KEPT = [
  'USA-PVH RETAIL STORES LLC',
  'MNG-MANGO U.K. LIMITED',
  'JSD-JLL Services GmbH',
  'AVI-SPL LLC',
  '0090 CORP-Corporate Office',
  '2020 Companies, Inc.',
  '77-7777356 Default Company for India',
  '2200 Germany',
  'C3 Trucking',
  'H2 Health',
  'R1 RCM Holdco Inc.',
  'K12 Inc',
  '7-Eleven, Inc.',
  '3M',
  'T-Mobile USA, Inc.',
  'Nilfisk',
];

test('Workday legal-entity codes are removed only when a real employer name remains', () => {
  for (const [input, expected] of STRIPPED) assert.equal(withoutEntityCode(input), expected, input);
  for (const input of KEPT) assert.equal(withoutEntityCode(input), input, input);
  assert.equal(
    withoutEntityCode(`6014-Janssen Biotech, Inc.${' \t'.repeat(50_000)}Legal Entity`),
    'Janssen Biotech, Inc.',
  );
});

test('a coded Workday name and the plain brand are the same employer everywhere names are compared', () => {
  assert.equal(companyIdentityKey('USA-NILIN Nilfisk, Inc.'), 'nilfisk');
  assert.ok(sameCompanyIdentity('USA-NILIN Nilfisk, Inc.', 'Nilfisk'));
  assert.ok(sameCompanyIdentity('94-1687665 Bank of America, National Association', 'Bank of America, National Association'));
  assert.ok(!sameCompanyIdentity('2200 Germany', '1000 Germany'));
  assert.equal(employerRelation('USA-NILIN Nilfisk, Inc.', 'Nilfisk'), 'same');
  // The 2026-09-18 repost that reached the Aim Fit queue beside an applied copy.
  assert.ok(mayRepeat(
    { title: 'Robotics Business Development Manager', company: 'USA-NILIN Nilfisk, Inc.' },
    { title: 'Robotics Business Development Manager', company: 'Nilfisk' },
  ));
});

const noRules = {
  companyNameRule: { findMany: async () => [] },
} as unknown as Pick<Prisma.TransactionClient, 'companyNameRule'>;

test('ingestion stores the uncoded name for Workday postings and leaves other sources alone', async () => {
  assert.equal(await standardizeIncomingCompany({
    company: 'USA-NILIN Nilfisk, Inc.',
    url: 'https://nilfisk.wd3.myworkdayjobs.com/en-US/Nilfisk/job/Plymouth-MN/Robotics-Business-Development-Manager_R017777',
  }, noRules), 'Nilfisk, Inc.');
  assert.equal(await standardizeIncomingCompany({
    company: '100 Panera, LLC',
    url: 'https://www.linkedin.com/jobs/view/123',
  }, noRules), '100 Panera, LLC');
});

test('an explicit company rule still wins over code removal', async () => {
  const store = {
    companyNameRule: { findMany: async () => [{ standardName: 'Nilfisk' }] },
  } as unknown as Pick<Prisma.TransactionClient, 'companyNameRule'>;
  assert.equal(await standardizeIncomingCompany({
    company: 'USA-NILIN Nilfisk, Inc.',
    url: 'https://nilfisk.wd3.myworkdayjobs.com/Nilfisk/job/x',
  }, store), 'Nilfisk');
});

test('existing coded Workday rows display and group under the plain brand', () => {
  assert.equal(companyDisplayName('USA-NILIN Nilfisk, Inc.', 'ATS-workday'), 'Nilfisk');
  assert.equal(companyDisplayName('LE001 Northwest Bank', 'ATS-workday'), 'Northwest Bank');
  assert.equal(companyDisplayName('100 Panera, LLC', 'LinkedIn (Apify)'), '100 Panera');
  assert.equal(companyDisplayGroupKey('USA-NILIN Nilfisk, Inc.'), companyDisplayGroupKey('Nilfisk'));
});

test('a company-name edit keeps the score and skips the rescore prompt', () => {
  const route = readFileSync(new URL('../../app/api/jobs/[id]/route.ts', import.meta.url), 'utf8');
  const overlay = readFileSync(new URL('../../components/ExpandOverlay.tsx', import.meta.url), 'utf8');
  assert.match(route, /const scoringInputChanged = titleChanged \|\| locationChanged \|\| descriptionChanged;/);
  // Company still refreshes lifecycle identity (applied-repeat fingerprint).
  assert.match(route, /const identityInputChanged = titleChanged \|\| companyChanged \|\| locationChanged;/);
  assert.match(overlay, /let skipRescore = !scoringDetailsChanged;/);
  assert.match(overlay, /if \(scoringDetailsChanged && shouldConfirmBeforeRescore\)/);
});
