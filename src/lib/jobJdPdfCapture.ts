import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import type { Prisma, PrismaClient } from './prismaClient';
import { captureCanonicalJobPdf } from './canonicalJobPdf';
import { jobAttachmentSelect, MAX_JOB_ATTACHMENTS } from './jobAttachments';
import { jobAttachmentKind } from './jobAttachmentKind';
import { companyDisplayName } from './companyPresentation';
import { effectiveJdCaptureUrl, readJdPdfCapture, type JobJdPdfCapture } from './jobJdPdfCaptureState';

type Store = Pick<PrismaClient, '$transaction' | 'job' | 'jobAttachment' | 'jobPipelineEvent'>;
type Transaction = Prisma.TransactionClient;
const eventType = 'jd_pdf_capture';
const attachmentQuery = { select: jobAttachmentSelect, orderBy: [{ uploadedAt: 'desc' as const }, { id: 'desc' as const }] };

async function latestCapture(jobId: string, store: Pick<Transaction, 'jobPipelineEvent'>) {
  const event = await store.jobPipelineEvent.findFirst({ where: { jobId, eventType }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] });
  return { capture: readJdPdfCapture(event?.details), occurredAt: event?.occurredAt };
}

async function appendCapture(jobId: string, capture: JobJdPdfCapture, previousTime: Date | undefined, tx: Transaction) {
  await tx.jobPipelineEvent.create({ data: {
    eventKey: `jd-pdf:${jobId}:${randomUUID()}`, jobId, eventType, stage: 'documents',
    details: capture, occurredAt: new Date(Math.max(Date.now(), (previousTime?.getTime() || 0) + 1)),
  } });
}

async function lockedJob(id: string, tx: Transaction) {
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${id} FOR UPDATE`;
  return tx.job.findUnique({ where: { id }, select: {
    id: true, title: true, company: true, employer: true, source: true, status: true,
    userCanonicalUrl: true, canonicalUrl: true, url: true, attachments: attachmentQuery,
  } });
}

export async function readJobJdPdfCapture(jobId: string, store: Store = prisma) {
  const job = await store.job.findUnique({ where: { id: jobId }, select: { id: true, attachments: attachmentQuery } });
  if (!job) return null;
  return { attachments: job.attachments, capture: (await latestCapture(jobId, store)).capture };
}

/** Metadata only: no job, description, score, lifecycle, or existing-file updates. */
export async function requestJobJdPdfCapture(jobId: string, store: Store = prisma) {
  return store.$transaction(async tx => {
    const job = await lockedJob(jobId, tx);
    if (!job) throw new Error('Job not found.');
    if (job.status !== 'interviewing') throw new Error('Mark the job Interviewing before capturing its JD.');
    const previous = await latestCapture(jobId, tx);
    if (job.attachments.some(attachment => jobAttachmentKind(attachment) === 'jd')) {
      return { capture: previous.capture, shouldRun: false };
    }
    if (previous.capture && ['queued', 'capturing'].includes(previous.capture.status)) {
      return { capture: previous.capture, shouldRun: previous.capture.status === 'queued' };
    }
    const sourceUrl = effectiveJdCaptureUrl(job);
    const capture: JobJdPdfCapture = { attemptId: randomUUID(), status: sourceUrl ? 'queued' : 'failed',
      sourceUrl, requestedAt: new Date().toISOString(),
      ...(!sourceUrl ? { error: 'Add the canonical job URL, then try again.' } : {}),
    };
    await appendCapture(jobId, capture, previous.occurredAt, tx);
    return { capture, shouldRun: capture.status === 'queued' };
  });
}

export async function runJobJdPdfCapture(jobId: string, attemptId: string, store: Store = prisma,
  capturePdf = captureCanonicalJobPdf) {
  const claimed = await store.$transaction(async tx => {
    const job = await lockedJob(jobId, tx);
    const previous = await latestCapture(jobId, tx);
    if (!job || previous.capture?.attemptId !== attemptId || previous.capture.status !== 'queued') return null;
    const existing = job.attachments.find(attachment => jobAttachmentKind(attachment) === 'jd');
    const problem = job.status !== 'interviewing' ? 'The job is no longer Interviewing. Capture cancelled.'
      : effectiveJdCaptureUrl(job) !== previous.capture.sourceUrl ? 'The canonical URL changed. Try again to capture the new page.'
        : job.attachments.length >= MAX_JOB_ATTACHMENTS ? 'This card already has 20 documents. Remove one, then try again.' : null;
    if (existing || problem) {
      await appendCapture(jobId, { ...previous.capture, status: existing ? 'ready' : 'failed',
        ...(existing ? { attachmentId: existing.id } : { error: problem! }) }, previous.occurredAt, tx);
      return null;
    }
    const capture = { ...previous.capture, status: 'capturing' as const };
    await appendCapture(jobId, capture, previous.occurredAt, tx);
    return { job, capture };
  });
  if (!claimed) return;
  let bytes: Buffer | undefined;
  let error: string | undefined;
  try {
    if (!claimed.capture.sourceUrl) throw new Error('Add the canonical job URL, then try again.');
    bytes = await capturePdf({ sourceUrl: claimed.capture.sourceUrl, title: claimed.job.title });
  } catch (failure) {
    error = failure instanceof Error ? failure.message.slice(0, 350) : 'PDF capture failed. Try again.';
  }
  await store.$transaction(async tx => {
    const job = await lockedJob(jobId, tx);
    const previous = await latestCapture(jobId, tx);
    if (!job || previous.capture?.attemptId !== attemptId || previous.capture.status !== 'capturing') return;
    const existing = job.attachments.find(attachment => jobAttachmentKind(attachment) === 'jd');
    if (existing) {
      await appendCapture(jobId, { ...claimed.capture, status: 'ready', attachmentId: existing.id }, previous.occurredAt, tx);
      return;
    }
    if (job.status !== 'interviewing') error = 'The job is no longer Interviewing. Capture cancelled.';
    if (effectiveJdCaptureUrl(job) !== claimed.capture.sourceUrl) error = 'The canonical URL changed. Try again to capture the new page.';
    if (job.attachments.length >= MAX_JOB_ATTACHMENTS) error = 'This card already has 20 documents. Remove one, then try again.';
    if (!bytes || error) {
      await appendCapture(jobId, { ...claimed.capture, status: 'failed', error: error || 'PDF capture failed. Try again.' }, previous.occurredAt, tx);
      return;
    }
    const company = job.employer || companyDisplayName(job.company, job.source);
    const fileName = `${company} - ${job.title} - Job Description`.replace(/[\\/\u0000-\u001f\u007f]/g, '-').slice(0, 170) + '.pdf';
    const attachment = await tx.jobAttachment.create({ data: {
      jobId, fileName, kind: 'jd', mimeType: 'application/pdf', sizeBytes: bytes.length, content: new Uint8Array(bytes),
    }, select: { id: true } });
    await appendCapture(jobId, { ...claimed.capture, status: 'ready', attachmentId: attachment.id }, previous.occurredAt, tx);
  });
}
