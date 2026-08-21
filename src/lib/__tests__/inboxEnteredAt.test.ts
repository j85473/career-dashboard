import assert from 'node:assert/strict';
import test from 'node:test';

import { INBOX_ENTERED_AT_SQL, INBOX_REVIEW_WINDOW_DAYS } from '../inboxEnteredAt';

test('the Inbox review window is 15 days', () => {
  assert.equal(INBOX_REVIEW_WINDOW_DAYS, 15);
});

test('the Inbox entry time definition reads pipeline events, not createdAt, first', () => {
  // Regression guard for the actual bug: "Newest" and the review-window cutoff
  // must both key off when a job actually entered Inbox status, not when the
  // row was first ingested — a job can sit in earlier pipeline stages for
  // weeks before Aim/Experience ever finish.
  const sql = INBOX_ENTERED_AT_SQL.sql;
  assert.match(sql, /"JobPipelineEvent"/);
  assert.match(sql, /enteredInbox/);
  assert.match(sql, /COALESCE/i);
  assert.match(sql, /"createdAt"/);
  // createdAt must be the fallback, not the primary source.
  assert.ok(sql.indexOf('JobPipelineEvent') < sql.indexOf('"createdAt"'));
});
