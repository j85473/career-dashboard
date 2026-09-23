/** Read an uploaded job document by job ID without changing the job or its scores. */
import mammoth from 'mammoth';
import { prisma } from '../src/lib/prisma';
import { extractPdfText } from '../src/lib/pdfText';

async function main() {
  const [, , jobId, requestedAttachmentId] = process.argv;
  if (!jobId) {
    console.error('Usage: npm run jd:read -- <job-id> [attachment-id]');
    process.exitCode = 2;
    return;
  }
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, title: true, company: true },
  });
  if (!job) throw new Error(`No job found for ID ${jobId}.`);
  const attachments = await prisma.jobAttachment.findMany({
    where: { jobId, ...(requestedAttachmentId ? { id: requestedAttachmentId } : {}) },
    orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
  });
  if (attachments.length === 0) throw new Error(`No matching document is attached to ${job.title} at ${job.company}.`);
  const attachment = attachments[0];
  console.error(`Job: ${job.title} at ${job.company} (${job.id})`);
  console.error(`Reading: ${attachment.fileName} (${attachment.id})`);
  if (!requestedAttachmentId && attachments.length > 1) {
    console.error('Other documents:');
    for (const item of attachments.slice(1)) console.error(`  ${item.id}  ${item.fileName}`);
  }

  let content: string;
  if (attachment.mimeType === 'application/pdf') {
    content = await extractPdfText(attachment.content);
  } else if (attachment.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    content = (await mammoth.extractRawText({ buffer: Buffer.from(attachment.content) })).value;
  } else {
    content = Buffer.from(attachment.content).toString('utf8');
  }
  if (!content.trim()) throw new Error('The document has no extractable text. Inspect the original file or use OCR.');
  process.stdout.write(content);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
