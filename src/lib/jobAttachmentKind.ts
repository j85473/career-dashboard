export type JobAttachmentKind = 'jd' | 'prep';

/** Older uploads have no saved kind; prep filenames distinguish them from the original JD uploads. */
export function jobAttachmentKind(attachment: { kind?: string | null; fileName: string }): JobAttachmentKind {
  if (attachment.kind === 'jd' || attachment.kind === 'prep') return attachment.kind;
  return /\b(?:prep|preparation|interview)\b/i.test(attachment.fileName.replace(/[_-]/g, ' ')) ? 'prep' : 'jd';
}
