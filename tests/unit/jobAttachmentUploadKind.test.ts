import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../../src/lib/prismaClient';

const saved: Array<{ id: string; kind: string; fileName: string; uploadedAt: Date }> = [];
const tx = {
  $queryRaw: async () => [],
  jobAttachment: {
    count: async () => 0,
    findFirst: async () => saved.at(-1) || null,
    create: async ({ data }: { data: { kind: string; fileName: string; uploadedAt: Date } }) => {
      const attachment = { id: `attachment-${saved.length}`, ...data }; saved.push(attachment); return attachment;
    },
    findMany: async () => [...saved].reverse(),
  },
};
(globalThis as unknown as { prisma: PrismaClient }).prisma = {
  job: { findUnique: async () => ({ id: 'job' }) },
  $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
} as unknown as PrismaClient;
const route = import('../../src/app/api/jobs/[id]/attachments/route');

test('uploads preserve the selected purpose independently of the filename and support older clients', async () => {
  const { POST } = await route;
  for (const kind of ['jd', 'prep', 'transcript', null, 'invalid']) {
    saved.length = 0;
    const form = new FormData();
    form.set('file', new File(['%PDF-1.7\nexample'], 'document.pdf', { type: 'application/pdf' }));
    if (kind !== null) form.set('kind', kind);
    const response = await POST(new Request('http://localhost/api/jobs/job/attachments', { method: 'POST', body: form }),
      { params: Promise.resolve({ id: 'job' }) });
    assert.equal(response.status, kind === 'invalid' ? 400 : 201);
    if (kind === 'invalid') assert.equal(saved.length, 0);
    else {
      assert.equal(saved[0].kind, kind || 'jd');
      assert.equal(saved[0].fileName, 'document.pdf');
    }
  }
});

test('several prep packs and transcript formats retain every upload with strictly increasing times', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T18:00:00Z') });
  saved.length = 0;
  const { POST } = await route;
  for (const [fileName, kind, content] of [
    ['first.pdf', 'prep', '%PDF-1.7\nfirst'],
    ['second.pdf', 'prep', '%PDF-1.7\nsecond'],
    ['recruiter.txt', 'transcript', 'Recruiter: Tell me about your experience.'],
    ['manager.vtt', 'transcript', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nManager: Welcome.'],
    ['final.srt', 'transcript', '1\n00:00:01,000 --> 00:00:02,000\nFinal interview.'],
  ]) {
    const form = new FormData(); form.set('file', new File([content], fileName)); form.set('kind', kind);
    const response = await POST(new Request('http://localhost/api/jobs/job/attachments', { method: 'POST', body: form }),
      { params: Promise.resolve({ id: 'job' }) });
    assert.equal(response.status, 201);
    const data = await response.json();
    assert.equal(data.attachments.length, saved.length);
    assert.equal(data.attachments[0].fileName, fileName);
  }
  assert.equal(saved.length, 5);
  assert.equal(saved.filter(item => item.kind === 'transcript').length, 3);
  for (let index = 1; index < saved.length; index++) assert.ok(saved[index].uploadedAt > saved[index - 1].uploadedAt);
});
