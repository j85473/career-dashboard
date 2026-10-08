import assert from 'node:assert/strict';
import test from 'node:test';
import { corroboratedOracleEmployer } from '../../src/lib/oracleEmployerEvidence';
const url = 'https://egjl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/100/';
const witnessUrl = url.replace('/100/', '/101/');
const candidate = { items: [{ Id: '100', LegalEmployerId: 300000032176044 }] };
const witness = { items: [{ Id: '101', LegalEmployerId: 300000032176044,
  ShortDescriptionStr: '“En JORSA DE LA SELVA S.A.C. estamos comprometidos con promover la equidad, la diversidad y la inclusión.' }] };
test('Oracle historical employer evidence joins the same verified legal entity within its tenant', () => {
  assert.equal(corroboratedOracleEmployer(candidate, url, { payload: witness, url: witnessUrl }), 'JORSA DE LA SELVA S.A.C.');
});
test('Oracle legal IDs cannot cross tenants, mismatch postings, or manufacture an employer label', () => {
  for (const invalid of [
    { items: [{ Id: '100', LegalEmployerId: 123 }] },
    { items: [{ Id: '100', LegalEmployerId: null }] },
    { items: [{ Id: '999', LegalEmployerId: 300000032176044 }] },
  ]) assert.equal(corroboratedOracleEmployer(invalid, url, { payload: witness, url: witnessUrl }), '');
  assert.equal(corroboratedOracleEmployer(candidate, url, { payload: witness, url: witnessUrl.replace('egjl', 'other') }), '');
  assert.equal(corroboratedOracleEmployer(candidate, url, { payload: { items: [{ Id: '101', LegalEmployerId: 300000032176044 }] }, url: witnessUrl }), '');
});
