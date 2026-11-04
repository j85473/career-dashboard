import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJobJdPdfCapture, runJobJdPdfCapture, readJobJdPdfCapture } from '../jobJdPdfCapture';
import { effectiveJdCaptureUrl, readJdPdfCapture } from '../jobJdPdfCaptureState';
import { validateCapturedPage, validateCapturedPdf } from '../canonicalJobPdf';

function fixture() {
  const job = { id: 'job', title: 'Channel Sales Manager', company: 'Employer', employer: null, source: 'ATS',
    status: 'interviewing', url: 'https://old.example/job', canonicalUrl: 'https://canonical.example/job',
    userCanonicalUrl: 'https://chosen.example/job', aimFitScore: 87, reqFitScore: 82, description: 'SAVED TEXT MUST NOT BECOME THE PDF' };
  const attachments: Array<{ id: string; kind: string | null; fileName: string; content?: Uint8Array }> = [];
  const events: Array<{ details: unknown; occurredAt: Date; id: string }> = [];
  const tx = {
    $queryRaw: async () => [{ id: job.id }],
    job: { findUnique: async () => ({ ...job, attachments: [...attachments] }) },
    jobAttachment: { create: async ({ data }: { data: typeof attachments[number] }) => {
      const attachment = { ...data, id: `attachment-${attachments.length}` }; attachments.push(attachment); return attachment;
    } },
    jobPipelineEvent: {
      findFirst: async () => [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0] || null,
      create: async ({ data }: { data: typeof events[number] }) => { const event = { ...data, id: String(events.length) }; events.push(event); return event; },
    },
  };
  let tail = Promise.resolve();
  const store = { ...tx, $transaction: <T>(run: (client: typeof tx) => Promise<T>) => {
    const result = tail.then(() => run(tx)); tail = result.then(() => {}, () => {}); return result;
  } } as unknown as Parameters<typeof requestJobJdPdfCapture>[1];
  return { job, attachments, events, store };
}

test('capture uses the user-selected canonical URL and saves an attachment without changing JD, scores, or lifecycle', async () => {
  const f = fixture(); const before = { ...f.job };
  const queued = await requestJobJdPdfCapture('job', f.store);
  const originalPdf = Buffer.from('%PDF-1.7\noriginal source bytes');
  await runJobJdPdfCapture('job', queued.capture!.attemptId, f.store, async subject => {
    assert.deepEqual(subject, { sourceUrl: 'https://chosen.example/job', title: 'Channel Sales Manager' });
    return originalPdf;
  });
  assert.equal(f.attachments.length, 1);
  assert.deepEqual(Buffer.from(f.attachments[0].content!), originalPdf);
  assert.equal(f.attachments[0].kind, 'jd');
  assert.deepEqual(f.job, before);
  assert.equal((await readJobJdPdfCapture('job', f.store))?.capture?.status, 'ready');
});

test('existing JDs skip capture, prep packs do not, and duplicate workers save only once', async () => {
  const f = fixture(); f.attachments.push({ id: 'prep', kind: 'prep', fileName: 'prep.pdf' });
  const queued = await requestJobJdPdfCapture('job', f.store); let captures = 0;
  const capture = async () => { captures++; return Buffer.from('%PDF-source'); };
  await Promise.all([runJobJdPdfCapture('job', queued.capture!.attemptId, f.store, capture), runJobJdPdfCapture('job', queued.capture!.attemptId, f.store, capture)]);
  assert.equal(captures, 1); assert.equal(f.attachments.length, 2);
  assert.equal((await requestJobJdPdfCapture('job', f.store)).shouldRun, false);
  assert.equal(f.attachments[0].id, 'prep');
});

test('failed capture stays retryable without using saved text or changing Interviewing', async () => {
  const f = fixture(); const queued = await requestJobJdPdfCapture('job', f.store);
  await runJobJdPdfCapture('job', queued.capture!.attemptId, f.store, async () => { throw new Error('The canonical page returned HTTP 403.'); });
  assert.equal(f.attachments.length, 0); assert.equal(f.job.status, 'interviewing');
  const state = (await readJobJdPdfCapture('job', f.store))!.capture!;
  assert.equal(state.status, 'failed'); assert.match(state.error!, /403/);
  const retry = await requestJobJdPdfCapture('job', f.store);
  assert.equal(retry.shouldRun, true); assert.notEqual(retry.capture!.attemptId, queued.capture!.attemptId);
});

test('manual uploads, URL corrections, status changes, and document limits are rechecked after the browser finishes', async () => {
  for (const action of ['manual', 'url', 'status', 'limit']) {
    const f = fixture(); const queued = await requestJobJdPdfCapture('job', f.store);
    await runJobJdPdfCapture('job', queued.capture!.attemptId, f.store, async () => {
      if (action === 'manual') f.attachments.push({ id: 'manual', kind: 'jd', fileName: 'manual.pdf' });
      if (action === 'url') f.job.userCanonicalUrl = 'https://corrected.example/job';
      if (action === 'status') f.job.status = 'applied';
      if (action === 'limit') for (let i = 0; i < 20; i++) f.attachments.push({ id: String(i), kind: 'prep', fileName: 'prep.pdf' });
      return Buffer.from('%PDF-source');
    });
    const state = (await readJobJdPdfCapture('job', f.store))!.capture!;
    assert.equal(state.status, action === 'manual' ? 'ready' : 'failed');
    assert.ok(f.attachments.every(attachment => attachment.content === undefined));
  }
});

test('missing source URLs fail visibly and interrupted attempts can be retried', async () => {
  const f = fixture(); Object.assign(f.job, { url: null, canonicalUrl: null, userCanonicalUrl: null });
  const result = await requestJobJdPdfCapture('job', f.store);
  assert.equal(result.shouldRun, false); assert.equal(result.capture?.status, 'failed');
  const old = { attemptId: 'old', status: 'capturing', sourceUrl: 'https://example.com/job', requestedAt: new Date(Date.now() - 180_000).toISOString() };
  assert.equal(readJdPdfCapture(old)?.status, 'failed');
  assert.equal(effectiveJdCaptureUrl({ canonicalUrl: 'https://canonical.example', url: 'https://other.example' }), 'https://canonical.example');
});

test('source capture rejects blank, blocked, wrong-job, and oversized output', () => {
  assert.throws(() => validateCapturedPage('Just a moment. Enable JavaScript and cookies. '.repeat(10), 'Sales Manager'));
  assert.throws(() => validateCapturedPage('Home page and company news. '.repeat(30), 'Channel Sales Manager'));
  assert.throws(() => validateCapturedPdf(Buffer.from('not a PDF')));
  assert.throws(() => validateCapturedPdf(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)])));
  validateCapturedPage('Channel Sales Manager. Responsibilities include building partners and growing the territory. '.repeat(8), 'Channel Sales Manager');
});

test('a superseded worker cannot save after an interrupted attempt is retried', async () => {
  const f = fixture();
  const first = await requestJobJdPdfCapture('job', f.store);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = runJobJdPdfCapture('job', first.capture!.attemptId, f.store, async () => {
    entered(); await gate; return Buffer.from('%PDF-old');
  });
  await started;
  const latest = f.events.at(-1)!;
  latest.details = { ...(latest.details as object), requestedAt: new Date(Date.now() - 180_000).toISOString() };
  const next = await requestJobJdPdfCapture('job', f.store);
  release(); await running;
  assert.equal(f.attachments.length, 0);
  await runJobJdPdfCapture('job', next.capture!.attemptId, f.store, async () => Buffer.from('%PDF-new'));
  assert.deepEqual(Buffer.from(f.attachments[0].content!), Buffer.from('%PDF-new'));
});
