import assert from 'node:assert/strict';
import test from 'node:test';

import { presentJobDescription } from '../jobDescriptionPresentation';

const varnishDescription = '<h3><strong>About Varnish Software</strong></h3>'
  + '<p><span>Varnish Software develops caching technology.</span><strong><br></strong></p>'
  + '<h4><strong>Key Responsibilities</strong></h4><ul>'
  + '<li><p>Deliver sales enablement and <em>Train-the-Trainer</em> sessions.</p></li>'
  + '<li><p>Conduct Quarterly Business Reviews (QBRs).</p></li></ul>'
  + '<h4><strong>Required Skills &amp; Experience</strong></h4>'
  + '<p>5+ years of experience.<br>Travel &lt;10%.</p>';

test('the Varnish HTML structure displays readable headings, paragraphs, bullets and entities', () => {
  const { description } = presentJobDescription({ description: varnishDescription });
  assert.match(description, /^About Varnish Software\nVarnish Software develops caching technology\./);
  assert.match(description, /Key Responsibilities\n• Deliver sales enablement and Train-the-Trainer sessions\./);
  assert.match(description, /\n• Conduct Quarterly Business Reviews \(QBRs\)\./);
  assert.match(description, /Required Skills & Experience\n5\+ years of experience\.\nTravel <10%\./);
  assert.doesNotMatch(description, /<\/?(?:h[1-6]|p|li|ul|strong|span|em|br)\b|&amp;/i);
});

test('escaped and doubly escaped provider markup is readable too', () => {
  for (const description of [
    '&lt;p&gt;Manage partners.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Grow accounts.&lt;/li&gt;&lt;/ul&gt;',
    '&amp;lt;p&amp;gt;Manage partners.&amp;lt;/p&amp;gt;&amp;lt;ul&amp;gt;&amp;lt;li&amp;gt;Grow accounts.&amp;lt;/li&amp;gt;&amp;lt;/ul&amp;gt;',
  ]) {
    assert.equal(presentJobDescription({ description }).description, 'Manage partners.\n• Grow accounts.');
  }
  assert.equal(presentJobDescription({ description: 'Skills &amp; Experience&nbsp;required.' }).description,
    'Skills & Experience\u00a0required.');
});

test('plain text, Markdown, comparisons and missing descriptions are preserved exactly', () => {
  for (const description of [undefined, null, '', '  Responsibilities\n\n• Keep  two spaces.\n',
    '## Qualifications\n- Travel <10%.\n- Salary <100k.\n- Target >90%.',
    'Use R&D reports. Preserve 💙 and 🏡.']) {
    const job = { description };
    assert.equal(presentJobDescription(job), job);
    assert.equal(presentJobDescription(job).description, description);
  }
});

test('presentation never mutates the stored description, scores, history or lifecycle', () => {
  const job = Object.freeze({
    id: 'dc67210c-e4e8-4169-90df-2ab81085e231', description: varnishDescription,
    status: 'inbox', scoringStatus: 'scored', aimFitScore: 82, reqFitScore: 85,
    aimAuthorityState: 'current', experienceAuthorityState: 'current',
    currentAim: Object.freeze({ id: 'aim-event', aimFitScore: 82 }),
    scoreHistory: Object.freeze([{ id: 'experience-event', experienceFitScore: 85 }]),
  });
  const presented = presentJobDescription(job);
  assert.equal(job.description, varnishDescription);
  assert.notEqual(presented.description, job.description);
  assert.deepEqual(presented, { ...job, description: presented.description });
  assert.equal(presented.currentAim, job.currentAim);
  assert.equal(presented.scoreHistory, job.scoreHistory);
  assert.deepEqual(presentJobDescription(presented), presented);
});

test('active HTML content is removed rather than executed or displayed', () => {
  const { description } = presentJobDescription({ description:
    '<style>secret-style</style><script>alert(1)</script><p>Manage accounts.</p>' });
  assert.equal(description, 'Manage accounts.');
});

test('the detail API presents a readable JD while retaining score events and making no database writes', async (t) => {
  const { GET } = await import('../../app/api/jobs/[id]/route');
  const { prisma } = await import('../prisma');
  const job = Object.freeze({
    id: 'dc67210c-e4e8-4169-90df-2ab81085e231', title: 'Partner Account Manager',
    company: 'Varnish Software', status: 'inbox', description: varnishDescription,
  });
  const scoreEvent = {
    id: 'preserved-score-event', jobId: job.id, family: 'legacy', evaluationType: 'standard',
    aimFitScore: 82, experienceFitScore: 85, staleAt: null, createdAt: new Date('2026-10-12T12:00:00Z'),
  };
  // Prisma delegate methods are virtual proxy properties, so replace them
  // directly and restore them after the test instead of mocking descriptors.
  const replace = (target: object, method: string, implementation: unknown) => {
    const original = Reflect.get(target, method);
    Reflect.set(target, method, implementation);
    t.after(() => { Reflect.set(target, method, original); });
    assert.equal(Reflect.get(target, method), implementation);
  };
  replace(prisma.job, 'findUnique', async () => job);
  replace(prisma.jobScoreEvent, 'findMany', async () => [scoreEvent]);
  replace(prisma, '$queryRaw', async () => [scoreEvent]);
  const noWrites = () => { throw new Error('Description presentation must not write to the database'); };
  replace(prisma, '$transaction', noWrites);
  replace(prisma.job, 'update', noWrites);
  replace(prisma.job, 'updateMany', noWrites);
  replace(prisma.jobScoreEvent, 'updateMany', noWrites);

  const response = await GET(new Request(`http://localhost/api/jobs/${job.id}`), {
    params: Promise.resolve({ id: job.id }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.job.description, /^About Varnish Software\n/);
  assert.doesNotMatch(body.job.description, /<h3>|<p>|&amp;/);
  assert.equal(body.job.aimFitScore, 82);
  assert.equal(body.job.reqFitScore, 85);
  assert.equal(body.job.scoreAuthorityState, 'current');
  assert.equal(body.job.currentScore.id, scoreEvent.id);
  assert.equal(body.job.scoreHistory[0].id, scoreEvent.id);
  assert.equal(body.job.status, job.status);
  assert.equal(job.description, varnishDescription);
});
