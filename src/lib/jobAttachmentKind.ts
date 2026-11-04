export type JobAttachmentKind = 'jd' | 'prep' | 'transcript';

/** Older uploads have no saved kind; prep filenames distinguish them from the original JD uploads. */
export function jobAttachmentKind(attachment: { kind?: string | null; fileName: string }): JobAttachmentKind {
  if (attachment.kind === 'jd' || attachment.kind === 'prep' || attachment.kind === 'transcript') return attachment.kind;
  return /\b(?:prep|preparation|interview)\b/i.test(attachment.fileName.replace(/[_-]/g, ' ')) ? 'prep' : 'jd';
}

/** Use server-assigned upload times, never filenames or interview dates, to choose the latest prep. */
export function newestJobAttachments<T extends { id: string; uploadedAt: string }>(attachments: readonly T[]): T[] {
  const time = (value: string) => Date.parse(value) || 0;
  return [...attachments].sort((a, b) => time(b.uploadedAt) - time(a.uploadedAt) || b.id.localeCompare(a.id));
}

export function jobAttachmentLabel(company: string, attachment: { kind?: string | null; fileName: string }): string {
  const kind = jobAttachmentKind(attachment);
  return `${company} ${kind === 'prep' ? 'interview prep' : kind === 'transcript' ? 'interview transcript' : 'job description'}`;
}
