import assert from 'node:assert/strict';
import test from 'node:test';

import { passesPreFilter } from '../jobFiltering';
import { assessJobDescriptionQuality, runLocalHeuristic } from '../jobScoring';

const resume = [{
  name: 'Workday Resume',
  text: 'channel sales partner management distributor relationships territory growth field sales account growth retention executive reviews',
}];

function localGate(title: string, description: string, company: string): boolean {
  return runLocalHeuristic({
    title,
    company,
    fullDescription: description,
    url: 'https://example.com/job',
    source: 'golden-replay',
    manualAts: null,
  }, resume, []).gatePass;
}

test('bounded human-decision replay preserves applied channel and high-travel opportunities', () => {
  const appliedGoldens = [
    {
      id: 'graco-human-applied',
      company: 'Graco',
      title: 'Manager, Channel Sales',
      location: 'Minneapolis, MN',
      description: 'Manage distributor relationships, partner growth, sell-through, retention, and account planning across an assigned territory.',
    },
    {
      id: 'butterflymx-high-travel',
      company: 'ButterflyMX',
      title: 'Regional Partner Manager - Western Territory',
      location: 'Remote – USA',
      description: 'This fully remote US role manages existing partners across a Western territory with account growth, retention, and 50% travel.',
    },
    {
      id: 'radformation-global-distributors',
      company: 'Radformation',
      title: 'Global Distribution Partner Manager',
      location: 'United States Work at Home',
      description: 'Manage distributor relationships, partner enablement, account growth, and international site travel approximately 40% of the time.',
    },
  ];

  for (const job of appliedGoldens) {
    const filter = passesPreFilter({ ...job, url: 'https://example.com/job' });
    assert.equal(filter.passes, true, `${job.id}: ${filter.reason}`);
    assert.equal(localGate(job.title, job.description, job.company), true, job.id);
  }
});

test('Aim-owned location rejection reaches manual Aim while JD quality remains fail closed', () => {
  const purpleWave = passesPreFilter({
    title: 'Territory Manager - Eastern North Dakota',
    company: 'Purple Wave',
    location: 'Fargo, ND',
    description: 'Candidates must reside in Fargo and travel through eastern North Dakota up to 75% of the time.',
    url: 'https://example.com/job',
  });
  assert.equal(purpleWave.passes, true, purpleWave.reason);

  for (const description of [
    'Sign in to apply. Create an account. Search jobs.',
    'This position has been filled. Browse other openings.',
    'Manage partner relationships. Five years of experience required...',
  ]) {
    assert.equal(assessJobDescriptionQuality(description).scorable, false, description);
  }
});
