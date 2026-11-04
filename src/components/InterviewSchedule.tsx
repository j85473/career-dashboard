'use client';

import { useState, useSyncExternalStore } from 'react';
import { CalendarDays } from 'lucide-react';
import type { JobInterviewItem, JobListItem } from '@/types/job';
import { interviewLocalInput } from '@/lib/jobInterviewSchedule';
import { showConfirm } from '@/lib/modal';

const subscribeTimezone = () => () => {};
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverTimezone = () => 'UTC';

export function InterviewSchedule({ job, onJobUpdate }: {
  job: JobListItem;
  onJobUpdate?: (id: string, updates: Partial<JobListItem>) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timezone = useSyncExternalStore(subscribeTimezone, browserTimezone, serverTimezone);
  const interviews = job.interviews || [];

  const edit = (item?: JobInterviewItem) => {
    setEditing(item?.id || 'new');
    setDate(item ? interviewLocalInput(item.scheduledAt) : '');
    setLabel(item?.label || '');
    setError('');
  };
  const save = async (method: 'POST' | 'PATCH' | 'DELETE', id?: string) => {
    let scheduledAt: string | undefined;
    if (method !== 'DELETE') {
      const parsed = new Date(date);
      if (!Number.isFinite(parsed.getTime()) || interviewLocalInput(parsed.toISOString()) !== date) {
        setError('Choose a valid date and time in your timezone.');
        return;
      }
      scheduledAt = parsed.toISOString();
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/interviews`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, scheduledAt, label }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The interview could not be saved.');
      onJobUpdate?.(job.id, { interviews: data.interviews });
      setEditing(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The interview could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="interview-schedule" aria-label={`Interviews for ${job.title}`} onClick={event => event.stopPropagation()}>
      <div className="interview-schedule-heading"><CalendarDays size={15} /> Interviews</div>
      {interviews.length === 0 && <p className="interview-schedule-empty">No interview date set</p>}
      {interviews.map(item => (
        <div className="interview-schedule-round" key={item.id}>
          <div>
            <span className="interview-round-label">{item.label || 'Interview'}</span>
            <time dateTime={item.scheduledAt}>{new Intl.DateTimeFormat(undefined, {
              weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
              hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: timezone,
            }).format(new Date(item.scheduledAt))}</time>
          </div>
          <button type="button" disabled={busy} onClick={() => edit(item)} aria-label={`Edit ${item.label || 'interview'} date`}>Edit</button>
        </div>
      ))}
      {editing === null ? (
        <button type="button" className="interview-add" disabled={busy} onClick={() => edit()}>+ Add interview date</button>
      ) : (
        <form className="interview-schedule-form" onSubmit={event => {
          event.preventDefault();
          void save(editing === 'new' ? 'POST' : 'PATCH', editing === 'new' ? undefined : editing);
        }}>
          <label>Round or interviewer (optional)
            <input value={label} maxLength={100} disabled={busy} placeholder="e.g. Hiring manager" onChange={event => setLabel(event.target.value)} />
          </label>
          <label>Interview date and time
            <input type="datetime-local" required value={date} disabled={busy} onChange={event => setDate(event.target.value)} />
          </label>
          <span className="interview-timezone">Times shown in {timezone}</span>
          <div className="interview-form-actions">
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save interview'}</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(null); setError(''); }}>Cancel</button>
            {editing !== 'new' && <button type="button" className="interview-remove" disabled={busy} onClick={async () => {
              if (await showConfirm('Remove this interview date from the job?', 'Remove date', 'Keep date')) void save('DELETE', editing);
            }}>Remove date</button>}
          </div>
        </form>
      )}
      {error && <p role="alert" className="interview-schedule-error">{error}</p>}
    </section>
  );
}
