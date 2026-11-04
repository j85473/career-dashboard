import assert from 'node:assert/strict';
import test from 'node:test';
import { compareInterviewJobs, parseInterviewInput, interviewLocalInput, INTERVIEW_LABEL_MAX_LENGTH } from '../jobInterviewSchedule';
import { interviewOrderedPage } from '../jobInterviewOrder';
import { defaultJobSort } from '../jobSort';

const now = Date.parse('2026-11-04T15:00:00Z');
const round = (scheduledAt: string) => ({ id: scheduledAt, scheduledAt: new Date(scheduledAt), label: '' });
const jobs = [
  { id: 'undated', interviews: [] },
  { id: 'past-old', interviews: [round('2026-10-01T14:00:00Z')] },
  { id: 'next-later', interviews: [round('2026-11-06T14:00:00Z')] },
  { id: 'multiple-rounds', interviews: [round('2026-11-01T14:00:00Z'), round('2026-11-05T14:00:00Z')] },
  { id: 'past-recent', interviews: [round('2026-11-03T14:00:00Z')] },
  { id: 'right-now', interviews: [round('2026-11-04T15:00:00Z')] },
];

test('the interview log defaults to interview time and keeps next rounds ahead of past or undated cards', () => {
  assert.equal(defaultJobSort('interviewing'), 'interview_time');
  assert.deepEqual([...jobs].sort((a, b) => compareInterviewJobs(a, b, now)).map(job => job.id),
    ['right-now', 'multiple-rounds', 'next-later', 'past-recent', 'past-old', 'undated']);
  assert.equal(compareInterviewJobs({ id: 'a' }, { id: 'b' }, now) < 0, true);
});

test('interview ordering is applied before page boundaries and retains the search predicate', async () => {
  const where = { status: 'interviewing', company: 'Exact employer' };
  const client = { job: { findMany: async (query: { where: unknown }) => {
    assert.deepEqual(query.where, where);
    return [...jobs];
  } } } as unknown as Parameters<typeof interviewOrderedPage>[3];
  assert.deepEqual(await interviewOrderedPage(where, 2, 2, client, now), {
    ids: ['next-later', 'past-recent'], total: 6,
  });
  assert.deepEqual(await interviewOrderedPage(where, 2, 6, client, now), { ids: [], total: 6 });
});

test('interview input requires an absolute time and accepts notes with long meeting links', () => {
  const parsed = parseInterviewInput({ scheduledAt: '2026-11-04T09:00:00-06:00', label: '  Recruiter  ' });
  assert.equal(parsed.scheduledAt.toISOString(), '2026-11-04T15:00:00.000Z');
  assert.equal(parsed.label, 'Recruiter');
  const notes = `Hiring manager\nhttps://teams.microsoft.com/l/meetup-join/${'a'.repeat(500)}?context=test`;
  assert.equal(parseInterviewInput({ scheduledAt: '2026-11-04T15:00:00Z', label: notes }).label, notes);
  for (const body of [null, {}, { scheduledAt: '2026-11-04T09:00' }, { scheduledAt: 'nonsense' },
    { scheduledAt: '2026-02-30T15:00:00Z' }, { scheduledAt: '2026-11-04T24:00:00Z' },
    { scheduledAt: '2026-11-04T15:00:00Z', label: 'x'.repeat(INTERVIEW_LABEL_MAX_LENGTH + 1) }]) {
    assert.throws(() => parseInterviewInput(body));
  }
  const local = new Date(2026, 10, 4, 9, 30);
  assert.equal(interviewLocalInput(local.toISOString()), '2026-11-04T09:30');
});
