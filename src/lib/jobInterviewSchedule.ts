type ScheduledInterview = { scheduledAt: string | Date };
type InterviewJob = { id: string; interviews?: readonly ScheduledInterview[] };

/** Next scheduled round, or the most recent past round when none are upcoming. */
export function interviewSortKey(job: InterviewJob, now: number): [number, number] {
  const dates = (job.interviews || []).map(item => new Date(item.scheduledAt).getTime()).filter(Number.isFinite);
  const upcoming = dates.filter(date => date >= now);
  if (upcoming.length) return [0, Math.min(...upcoming)];
  if (dates.length) return [1, -Math.max(...dates)];
  return [2, 0];
}

export function compareInterviewJobs(a: InterviewJob, b: InterviewJob, now: number): number {
  const left = interviewSortKey(a, now);
  const right = interviewSortKey(b, now);
  return left[0] - right[0] || left[1] - right[1] || a.id.localeCompare(b.id);
}

export function parseInterviewInput(body: unknown): { scheduledAt: Date; label: string } {
  if (!body || typeof body !== 'object') throw new Error('Enter an interview date and time.');
  const { scheduledAt, label = '' } = body as Record<string, unknown>;
  // Require an absolute instant so a server timezone cannot shift the interview.
  if (typeof scheduledAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt)
    || !Number.isFinite(Date.parse(scheduledAt))) {
    throw new Error('Enter a valid interview date and time with a timezone.');
  }
  const [year, month, day] = scheduledAt.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day || Number(scheduledAt.slice(11, 13)) > 23) {
    throw new Error('Enter a valid interview date and time with a timezone.');
  }
  if (typeof label !== 'string' || label.trim().length > 100) {
    throw new Error('Keep the interview label to 100 characters or fewer.');
  }
  return { scheduledAt: new Date(scheduledAt), label: label.trim() };
}

/** datetime-local controls use the viewer's timezone, including its date-specific DST offset. */
export function interviewLocalInput(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
