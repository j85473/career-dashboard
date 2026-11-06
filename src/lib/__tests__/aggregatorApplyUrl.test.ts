import assert from 'node:assert/strict';
import test from 'node:test';
import { preferredAggregatorApplyUrl } from '../aggregatorApplyUrl';
import { parseJSearchJob } from '../jobIngestion';

const copy = 'https://www.jobleads.com/us/job/account-manager--abc';
const direct = 'https://job-boards.greenhouse.io/acme/jobs/123456';

test('both provider shapes prefer a later direct posting over the first aggregator', () => {
  for (const options of [
    [{ title: 'Jobleads', link: copy }, { title: 'Acme', link: direct }],
    [{ publisher: 'Jobleads', apply_link: copy }, { publisher: 'Acme', apply_link: direct }],
  ]) assert.equal(preferredAggregatorApplyUrl({ primary: copy, options }), direct);
  assert.equal(parseJSearchJob({ job_uid: 'stable', job_title: 'Account Manager', job_apply_link: copy,
    apply_options: [{ apply_link: direct }] })?.url, direct);
});

test('conflicting requisitions retain the original link and unsafe URLs cannot replace it', () => {
  assert.equal(preferredAggregatorApplyUrl({ primary: copy,
    options: [{ link: direct }, { link: direct.replace('123456', '654321') }] }), copy);
  assert.equal(preferredAggregatorApplyUrl({ primary: copy,
    options: [{ link: direct }, { link: direct.replace('/acme/', '/unrelated/') }] }), copy);
  assert.equal(preferredAggregatorApplyUrl({ primary: copy,
    options: [{ link: direct }, { link: direct.replace('job-boards.', 'boards.') + '?gh_src=tracking' }] }), direct);
  for (const link of ['javascript:alert(1)', 'https://user:password@job-boards.greenhouse.io/acme/jobs/123456',
    'https://job-boards.greenhouse.io/acme', 'https://greenhouse.io.evil.example/acme/jobs/123456']) {
    assert.equal(preferredAggregatorApplyUrl({ primary: copy, options: [{ link, is_direct: true }] }), copy);
  }
});

test('fallback links survive absent and malformed options', () => {
  for (const options of [null, {}, [], [null, {}, { link: 123 }]]) {
    assert.equal(preferredAggregatorApplyUrl({ fallback: copy, options }), copy);
  }
  assert.equal(preferredAggregatorApplyUrl({ options: [{ link: copy }] }), copy);
});
