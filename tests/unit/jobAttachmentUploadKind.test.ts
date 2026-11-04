import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../../src/lib/prismaClient';

const saved: Array<{ kind: string; fileName: string }> = [];
const tx = {
  $queryRaw: async () => [],
  jobAttachment: {
    count: async () => 0,
    create: async ({ data }: { data: { kind: string; fileName: string } }) => { saved.push(data); return { id: 'attachment', ...data }; },
  },
};
(globalThis as unknown as { prisma: PrismaClient }).prisma = {
  job: { findUnique: async () => ({ id: 'job' }) },
  $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
} as unknown as PrismaClient;
const route = import('../../src/app/api/jobs/[id]/attachments/route');

test('uploads preserve the selected purpose independently of the filename and support older clients', async () => {
  const { POST } = await route;
  for (const kind of ['jd', 'prep', null, 'invalid']) {
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
