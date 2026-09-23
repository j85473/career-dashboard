export const MAX_JOB_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_JOB_ATTACHMENTS = 20;

export const jobAttachmentSelect = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedAt: true,
} as const;

export function cleanAttachmentFileName(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || 'document';
}

export function attachmentMimeType(fileName: string, bytes: Uint8Array): string | null {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'pdf' && bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (extension === 'docx' && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (extension === 'txt' && !bytes.includes(0)) {
    const decoded = new TextDecoder('utf-8', { fatal: true });
    try { decoded.decode(bytes); return 'text/plain; charset=utf-8'; } catch { return null; }
  }
  return null;
}
