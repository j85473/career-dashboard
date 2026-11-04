import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InterviewSchedule } from '../../components/InterviewSchedule';

function renderNotes(label: string) {
  return renderToStaticMarkup(React.createElement(InterviewSchedule, {
    job: { id: 'job', title: 'Sales Manager', company: 'Employer', status: 'interviewing',
      interviews: [{ id: 'round', scheduledAt: '2026-11-05T18:00:00Z', label }] },
  }));
}

test('saved interview notes render meeting links in new tabs and preserve surrounding text', () => {
  const html = renderNotes('Hiring manager\nJoin https://zoom.us/j/123?pwd=abc&name=Joe or https://meet.google.com/abc-defg-hij');
  assert.match(html, /Hiring manager\nJoin /);
  assert.match(html, /href="https:\/\/zoom.us\/j\/123\?pwd=abc&amp;name=Joe" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/meet.google.com\/abc-defg-hij"/);
  assert.equal((html.match(/<a /g) || []).length, 2);
});

test('punctuation around meeting links stays outside the destination', () => {
  const html = renderNotes('Join (https://zoom.us/j/123). More: https://example.com/room(test)');
  assert.match(html, /href="https:\/\/zoom.us\/j\/123"/);
  assert.match(html, /<\/a>\)\.<\/span>/);
  assert.match(html, /href="https:\/\/example.com\/room\(test\)"/);
});

test('notes stay escaped and non-web schemes are not made clickable', () => {
  const html = renderNotes('<script>alert(1)</script> javascript:alert(1) https://');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<a /);
  assert.match(renderNotes(''), />Interview<\/span>/);
});
