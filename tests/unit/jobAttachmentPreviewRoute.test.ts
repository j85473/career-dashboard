import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../../src/lib/prismaClient';

let mimeType = 'application/pdf';
let found = true;
let query: unknown;
const content = Buffer.from('%PDF-1.7\nprep pack');
(globalThis as unknown as { prisma: PrismaClient }).prisma = {
  jobAttachment: { findFirst: async (args: unknown) => {
    query = args;
    return found ? { fileName: 'Interview prep pack.pdf', mimeType, sizeBytes: content.length, content } : null;
  } },
} as unknown as PrismaClient;
const route = import('../../src/app/api/jobs/[id]/attachments/[attachmentId]/route');
const context = { params: Promise.resolve({ id: 'job-a', attachmentId: 'prep-a' }) };

test('prep pack PDFs can open inline with unchanged bytes and retain a download option', async () => {
  const api = await route;
  let response = await api.GET(new Request('http://localhost/api/jobs/job-a/attachments/prep-a?inline=1'), context);
  assert.deepEqual(query, { where: { id: 'prep-a', jobId: 'job-a' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Disposition')!, /^inline;/);
  assert.match(response.headers.get('Content-Disposition')!, /Interview%20prep%20pack.pdf/);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  response = await api.GET(new Request('http://localhost/api/jobs/job-a/attachments/prep-a'), context);
  assert.match(response.headers.get('Content-Disposition')!, /^attachment;/);
});

test('text prep notes can open inline, while Word files always download', async () => {
  const api = await route;
  mimeType = 'text/plain; charset=utf-8';
  let response = await api.GET(new Request('http://localhost/api/jobs/job-a/attachments/prep-a?inline=1'), context);
  assert.match(response.headers.get('Content-Disposition')!, /^inline;/);
  mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  response = await api.GET(new Request('http://localhost/api/jobs/job-a/attachments/prep-a?inline=1'), context);
  assert.match(response.headers.get('Content-Disposition')!, /^attachment;/);
  found = false;
  response = await api.GET(new Request('http://localhost/api/jobs/foreign-job/attachments/prep-a?inline=1'), {
    params: Promise.resolve({ id: 'foreign-job', attachmentId: 'prep-a' }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(query, { where: { id: 'prep-a', jobId: 'foreign-job' } });
});
