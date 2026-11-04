'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Paperclip, X } from 'lucide-react';
import { showConfirm } from '@/lib/modal';
import type { JobAttachmentItem, JobListItem } from '@/types/job';
import { jobAttachmentKind } from '@/lib/jobAttachmentKind';
import { companyDisplayName } from '@/lib/companyPresentation';
import { JobDocumentPreview } from '@/components/JobDocumentPreview';
import type { JobJdPdfCapture } from '@/lib/jobJdPdfCaptureState';

export function JobDocuments({ job, onJobUpdate }: {
  job: JobListItem;
  onJobUpdate?: (jobId: string, updates: Partial<JobListItem>) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploadKind, setUploadKind] = useState<'jd' | 'prep'>('prep');
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<JobAttachmentItem | null>(null);
  const [capture, setCapture] = useState<JobJdPdfCapture | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const attachments = job.attachments || [];
  const company = job.employer || companyDisplayName(job.company, job.source);
  const busy = uploading || removing !== null;
  const hasJd = attachments.some(attachment => jobAttachmentKind(attachment) === 'jd');
  const updateRef = useRef(onJobUpdate);
  useEffect(() => { updateRef.current = onJobUpdate; }, [onJobUpdate]);

  useEffect(() => {
    if (job.status !== 'interviewing' || hasJd) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}/jd-pdf`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not check JD capture.');
        if (controller.signal.aborted) return;
        setCaptureError('');
        setCapture(data.capture);
        if (data.attachments?.some((item: JobAttachmentItem) => jobAttachmentKind(item) === 'jd')) {
          updateRef.current?.(job.id, { attachments: data.attachments });
        } else if (data.capture && ['queued', 'capturing'].includes(data.capture.status)) {
          timer = setTimeout(() => { void poll(); }, 2000);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setCaptureError(failure instanceof Error ? failure.message : 'Could not check JD capture.');
          timer = setTimeout(() => { void poll(); }, 3000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job.id, job.status, hasJd, captureBusy]);

  const retryCapture = async () => {
    setCaptureBusy(true);
    setCaptureError('');
    setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/jd-pdf`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start JD capture.');
      setCapture(data.capture);
      if (data.attachments) updateRef.current?.(job.id, { attachments: data.attachments });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not start JD capture.');
    } finally { setCaptureBusy(false); }
  };

  const upload = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      setError('Documents must be 10 MB or smaller.');
      if (input.current) input.current.value = '';
      return;
    }
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('kind', uploadKind);
      const response = await fetch(`/api/jobs/${job.id}/attachments`, { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The document could not be uploaded.');
      onJobUpdate?.(job.id, { attachments: [data.attachment, ...attachments] });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The document could not be uploaded.');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (attachmentId: string, fileName: string) => {
    if (!await showConfirm(`Remove ${fileName} from this job? The uploaded copy will be deleted.`, 'Remove document', 'Keep document')) return;
    setRemoving(attachmentId);
    setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/attachments/${attachmentId}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The document could not be removed.');
      onJobUpdate?.(job.id, { attachments: attachments.filter(item => item.id !== attachmentId) });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The document could not be removed.');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="job-documents" aria-label={`Documents for ${job.title}`} onClick={event => event.stopPropagation()}>
      <div className="job-documents-heading">Documents</div>
      <div className="job-card-attachments">
        <input ref={input} className="job-attachment-file-input" type="file"
          accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          aria-label={`Choose a document for ${job.title} at ${job.employer || job.company}`}
          disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); }} />
        <button type="button" className="job-attachment-upload" disabled={busy}
          onClick={() => { setUploadKind('jd'); input.current?.click(); }}>
          <Paperclip size={14} /> {uploading && uploadKind === 'jd' ? 'Uploading…' : 'Attach JD'}
        </button>
        <button type="button" className="job-attachment-upload job-prep-pack-upload" disabled={busy}
          onClick={() => { setUploadKind('prep'); input.current?.click(); }}>
          <Paperclip size={14} /> {uploading && uploadKind === 'prep' ? 'Uploading…' : 'Attach prep pack'}
        </button>
      </div>
      <div className="job-documents-help">PDF, DOCX or TXT · Up to 10 MB each</div>
      {job.status === 'interviewing' && !hasJd && <div className="job-jd-capture">
        {captureError && <p role="status">{captureError}</p>}
        {captureBusy || capture?.status === 'queued' || capture?.status === 'capturing'
          ? <p role="status">Capturing job description from the canonical page…</p>
          : <>
            {capture?.status === 'failed' && <p role="status">{capture.error || 'The JD PDF could not be captured.'}</p>}
            <button type="button" className="job-attachment-upload" disabled={busy} onClick={() => void retryCapture()}>
              {capture?.status === 'failed' ? 'Retry JD capture' : 'Capture JD from source'}
            </button>
          </>}
      </div>}
      {attachments.length > 0 && <ul className="job-document-list">
        {attachments.map(attachment => {
          const url = `/api/jobs/${job.id}/attachments/${attachment.id}`;
          const label = `${company} ${jobAttachmentKind(attachment) === 'prep' ? 'interview prep' : 'job description'}`;
          const isPdf = attachment.mimeType === 'application/pdf';
          const previewable = attachment.mimeType === 'application/pdf' || attachment.mimeType.startsWith('text/plain');
          return <li key={attachment.id} className="job-attachment-item">
            <a className="job-attachment-link" href={previewable ? `${url}?inline=1` : url}
              target={previewable && !isPdf ? '_blank' : undefined} rel={previewable && !isPdf ? 'noopener noreferrer' : undefined}
              aria-haspopup={isPdf ? 'dialog' : undefined}
              onClick={isPdf ? event => { event.preventDefault(); setPreview(attachment); } : undefined}
              download={previewable ? undefined : attachment.fileName}
              title={`${previewable ? 'Open' : 'Download'} ${label} · ${attachment.fileName} · ${(attachment.sizeBytes / 1024).toFixed(0)} KB`}>
              {label}
            </a>
            <a className="job-attachment-download" href={url} download={attachment.fileName}
              aria-label={`Download ${label}`} title={`Download ${attachment.fileName}`}><Download size={13} /></a>
            <button type="button" className="job-attachment-remove" disabled={busy}
              aria-label={`Remove ${attachment.fileName} from ${job.title}`} title={`Remove ${attachment.fileName}`}
              onClick={() => void remove(attachment.id, attachment.fileName)}><X size={12} /></button>
          </li>;
        })}
      </ul>}
      {error && <p className="job-document-error" role="alert">{error}</p>}
      {preview && <JobDocumentPreview
        url={`/api/jobs/${job.id}/attachments/${preview.id}`}
        label={`${company} ${jobAttachmentKind(preview) === 'prep' ? 'interview prep' : 'job description'}`}
        fileName={preview.fileName}
        onClose={() => setPreview(null)}
      />}
    </section>
  );
}
