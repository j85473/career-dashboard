import assert from 'node:assert/strict';
import test from 'node:test';
import fixtures from './fixtures/aggregatorStoredMatches.json';
import { selectDirectAtsMatch } from '../atsDirectMatch';

for (const fixture of fixtures) {
  test(`stored ${fixture.job.company} posting survives the observed aggregator formatting`, () => {
    assert.equal(selectDirectAtsMatch(fixture.job, fixture.postings)?.url, fixture.expectedUrl);
  });
}

const ferguson = fixtures.find(fixture => fixture.job.company === 'Ferguson Enterprises')!;

test('a long truncated reprint requires every supplied character in order, not shared words', () => {
  const changed = { ...ferguson.job,
    description: ferguson.job.description.replace('50%', '80%') };
  assert.notEqual(changed.description, ferguson.job.description);
  assert.equal(selectDirectAtsMatch(changed, ferguson.postings), null);
  const short = { ...ferguson.job, description: ferguson.job.description.slice(0, 2_000) };
  assert.equal(selectDirectAtsMatch(short, ferguson.postings), null);
});

test('two requisitions sharing the same truncated passage remain ambiguous', () => {
  const first = ferguson.postings[0];
  assert.equal(selectDirectAtsMatch(ferguson.job, [first, {
    ...first, url: first.url.replace('R-140501', 'R-999999'),
    description: `${first.description}\nA different compensation package applies.`,
  }]), null);
});

test('a shared footer cannot identify a differently named role', () => {
  const first = ferguson.postings[0];
  assert.equal(selectDirectAtsMatch(ferguson.job, [{ ...first,
    description: `${'Different role duties and qualifications. '.repeat(30)}${first.description}`,
  }]), null);
});

test('a long shared introduction without the employer role title cannot prove a renamed job', () => {
  const intro = 'Our company creates products for customers across the world and supports local communities. '.repeat(50);
  assert.equal(selectDirectAtsMatch({ title: 'Account Manager', location: 'USA', description: intro }, [{
    title: 'Implementation Engineer', location: 'USA', url: 'https://jobs.lever.co/acme/another-role',
    description: `${intro}${'Specialist engineering duties and integration experience are required. '.repeat(15)}`,
  }]), null);
});
