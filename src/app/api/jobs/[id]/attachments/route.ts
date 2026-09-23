import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  MAX_JOB_ATTACHMENT_BYTES,
  MAX_JOB_ATTACHMENTS,
  attachmentMimeType,
  cleanAttachmentFileName,
  jobAttachmentSelect,
} from '@/lib/jobAttachments';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const job = await prisma.job.findUnique({ where: { id }, select: { id: true } });
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  const attachments = await prisma.jobAttachment.findMany({
    where: { jobId: id }, select: jobAttachmentSelect,
    orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
  });
  return NextResponse.json({ attachments }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_JOB_ATTACHMENT_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'Documents must be 10 MB or smaller.' }, { status: 413 });
  }
  const job = await prisma.job.findUnique({ where: { id }, select: { id: true } });
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: 'Upload a PDF, DOCX, or TXT document.' }, { status: 400 }); }
  const file = form.get('file');
  if (!(file instanceof File) || !file.name || file.size === 0) {
    return NextResponse.json({ error: 'Choose a document to upload.' }, { status: 400 });
  }
  if (file.size > MAX_JOB_ATTACHMENT_BYTES) {
    return NextResponse.json({ error: 'Documents must be 10 MB or smaller.' }, { status: 413 });
  }
  const fileName = cleanAttachmentFileName(file.name);
  const content = Buffer.from(await file.arrayBuffer());
  const mimeType = attachmentMimeType(fileName, content);
  if (!mimeType) {
    return NextResponse.json({ error: 'Only valid PDF, DOCX, and UTF-8 TXT documents are supported.' }, { status: 400 });
  }
  const attachment = await prisma.$transaction(async (tx) => {
    // Serialize concurrent uploads for this job so the per-job limit holds.
    await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
    const count = await tx.jobAttachment.count({ where: { jobId: id } });
    if (count >= MAX_JOB_ATTACHMENTS) return null;
    return tx.jobAttachment.create({
      data: { jobId: id, fileName, mimeType, sizeBytes: content.length, content },
      select: jobAttachmentSelect,
    });
  });
  if (!attachment) return NextResponse.json({ error: 'This job already has 20 documents.' }, { status: 409 });
  return NextResponse.json({ attachment }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
}
