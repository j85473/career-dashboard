'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Paperclip, X } from 'lucide-react';
import { showConfirm } from '@/lib/modal';
import type { JobAttachmentItem, JobListItem } from '@/types/job';
import { jobAttachmentKind, jobAttachmentLabel, newestJobAttachments, type JobAttachmentKind } from '@/lib/jobAttachmentKind';
import { companyDisplayName } from '@/lib/companyPresentation';
import { JobDocumentPreview } from '@/components/JobDocumentPreview';
import type { JobJdPdfCapture } from '@/lib/jobJdPdfCaptureState';

const NO_ATTACHMENTS: JobAttachmentItem[] = [];

export function JobDocuments({ job, onJobUpdate }: {
  job: JobListItem;
  onJobUpdate?: (jobId: string, updates: Partial<JobListItem>) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploadKind, setUploadKind] = useState<JobAttachmentKind>('prep');
  const uploadKindRef = useRef<JobAttachmentKind>('prep');
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<JobAttachmentItem | null>(null);
  const [capture, setCapture] = useState<JobJdPdfCapture | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const attachments = job.attachments || NO_ATTACHMENTS;
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  const ordered = newestJobAttachments(attachments);
  const prepPacks = ordered.filter(attachment => jobAttachmentKind(attachment) === 'prep');
  const transcripts = ordered.filter(attachment => jobAttachmentKind(attachment) === 'transcript');
  const descriptions = ordered.filter(attachment => jobAttachmentKind(attachment) === 'jd');
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

  const chooseFiles = (kind: JobAttachmentKind) => {
    uploadKindRef.current = kind;
    setUploadKind(kind);
    input.current?.click();
  };

  const upload = async (files: File[]) => {
    const kind = uploadKindRef.current;
    setUploading(true);
    setError('');
    const failures: string[] = [];
    try {
      for (const file of files) {
        try {
          if (file.size > 10 * 1024 * 1024) throw new Error('Documents must be 10 MB or smaller.');
          const form = new FormData();
          form.set('file', file);
          form.set('kind', kind);
          const response = await fetch(`/api/jobs/${job.id}/attachments`, { method: 'POST', body: form });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'The document could not be uploaded.');
          const next = newestJobAttachments<JobAttachmentItem>(data.attachments || [data.attachment, ...attachmentsRef.current]);
          attachmentsRef.current = next;
          updateRef.current?.(job.id, { attachments: next });
        } catch (failure) {
          failures.push(`${file.name}: ${failure instanceof Error ? failure.message : 'The document could not be uploaded.'}`);
        }
      }
    } finally {
      setError(failures.join('\n'));
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const attachmentRow = (attachment: JobAttachmentItem, label: string, showFileName = false) => {
    const url = `/api/jobs/${job.id}/attachments/${attachment.id}`;
    const previewable = attachment.mimeType === 'application/pdf' || attachment.mimeType.startsWith('text/');
    const validDate = Number.isFinite(Date.parse(attachment.uploadedAt));
    const added = validDate ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Chicago' }).format(new Date(attachment.uploadedAt)) : '';
    return <li key={attachment.id} className="job-document-entry">
      <div className="job-attachment-item">
        <a className="job-attachment-link" href={previewable ? `${url}?inline=1` : url}
          aria-haspopup={previewable ? 'dialog' : undefined}
          onClick={previewable ? event => { event.preventDefault(); setPreview(attachment); } : undefined}
          download={previewable ? undefined : attachment.fileName}
          title={`${previewable ? 'Open' : 'Download'} ${label} · ${attachment.fileName} · ${(attachment.sizeBytes / 1024).toFixed(0)} KB`}>
          {label}
        </a>
        <a className="job-attachment-download" href={url} download={attachment.fileName}
          aria-label={`Download ${label}`} title={`Download ${attachment.fileName}`}><Download size={13} /></a>
        <button type="button" className="job-attachment-remove" disabled={busy}
          aria-label={`Remove ${attachment.fileName} from ${job.title}`} title={`Remove ${attachment.fileName}`}
          onClick={() => void remove(attachment.id, attachment.fileName)}><X size={12} /></button>
      </div>
      {(showFileName || added) && <div className="job-document-meta">
        {showFileName && attachment.fileName}{showFileName && added ? ' · ' : ''}{added && `Added ${added}`}
      </div>}
    </li>;
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
        <input ref={input} className="job-attachment-file-input" type="file" multiple
          accept=".pdf,.docx,.txt,.vtt,.srt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/vtt"
          aria-label={`Choose a document for ${job.title} at ${job.employer || job.company}`}
          disabled={busy} onChange={event => { const files = Array.from(event.currentTarget.files || []); if (files.length) void upload(files); }} />
        <button type="button" className="job-attachment-upload" disabled={busy}
          onClick={() => chooseFiles('jd')}>
          <Paperclip size={14} /> {uploading && uploadKind === 'jd' ? 'Uploading…' : 'Attach JD'}
        </button>
        <button type="button" className="job-attachment-upload job-prep-pack-upload" disabled={busy}
          onClick={() => chooseFiles('prep')}>
          <Paperclip size={14} /> {uploading && uploadKind === 'prep' ? 'Uploading…' : 'Attach prep pack'}
        </button>
        <button type="button" className="job-attachment-upload" disabled={busy}
          onClick={() => chooseFiles('transcript')}>
          <Paperclip size={14} /> {uploading && uploadKind === 'transcript' ? 'Uploading…' : 'Attach transcripts'}
        </button>
      </div>
      <div className="job-documents-help">Select one or more PDF, DOCX, TXT, VTT or SRT files · Up to 10 MB each · 20 documents per card</div>
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
      {(prepPacks.length > 0 || descriptions.length > 0) && <ul className="job-document-list">
        {prepPacks[0] && attachmentRow(prepPacks[0], jobAttachmentLabel(company, prepPacks[0]), true)}
        {descriptions.map(attachment => attachmentRow(attachment, jobAttachmentLabel(company, attachment)))}
      </ul>}
      {prepPacks.length > 1 && <details className="job-document-history">
        <summary>Older prep packs ({prepPacks.length - 1})</summary>
        <ul className="job-document-list">{prepPacks.slice(1).map(attachment => attachmentRow(attachment, attachment.fileName))}</ul>
      </details>}
      {transcripts.length > 0 && <div className="job-document-transcripts">
        <div className="job-documents-heading">Interview transcripts ({transcripts.length})</div>
        <ul className="job-document-list">{transcripts.map(attachment => attachmentRow(attachment, attachment.fileName))}</ul>
      </div>}
      {error && <p className="job-document-error" role="alert">{error}</p>}
      {preview && <JobDocumentPreview
        url={`/api/jobs/${job.id}/attachments/${preview.id}`}
        label={jobAttachmentLabel(company, preview)}
        fileName={preview.fileName}
        mimeType={preview.mimeType}
        onClose={() => setPreview(null)}
      />}
    </section>
  );
}
