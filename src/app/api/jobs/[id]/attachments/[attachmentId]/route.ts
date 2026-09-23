import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await context.params;
  const attachment = await prisma.jobAttachment.findFirst({
    where: { id: attachmentId, jobId: id },
  });
  if (!attachment) return NextResponse.json({ error: 'Document not found on this job.' }, { status: 404 });
  const encodedName = encodeURIComponent(attachment.fileName);
  const disposition = attachment.mimeType === 'application/pdf' ? 'inline' : 'attachment';
  return new Response(new Uint8Array(attachment.content), {
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Length': String(attachment.sizeBytes),
      'Content-Disposition': `${disposition}; filename="document"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await context.params;
  const result = await prisma.jobAttachment.deleteMany({ where: { id: attachmentId, jobId: id } });
  if (result.count === 0) return NextResponse.json({ error: 'Document not found on this job.' }, { status: 404 });
  return NextResponse.json({ removed: true }, { headers: { 'Cache-Control': 'private, no-store' } });
}
