'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';

export function JobDocumentPreview({ url, label, fileName, onClose }: {
  url: string;
  label: string;
  fileName: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <dialog ref={dialogRef} className="job-document-preview" aria-labelledby={titleId}
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <header className="job-document-preview-header">
        <h2 id={titleId} title={fileName}>{label}</h2>
        <div className="job-document-preview-actions">
          <a href={url} download={fileName} aria-label={`Download ${label}`}><Download size={16} /> Download</a>
          <button type="button" onClick={onClose} aria-label="Close document preview"><X size={20} /></button>
        </div>
      </header>
      <iframe className="job-document-preview-frame" src={`${url}?inline=1`} title={label} />
    </dialog>,
    document.body,
  );
}
