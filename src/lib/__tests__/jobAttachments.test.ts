import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentMimeType, cleanAttachmentFileName } from '../jobAttachments';

test('document validation checks both extension and content signature', () => {
  const pdf = Buffer.from('%PDF-1.7\nexample');
  assert.equal(attachmentMimeType('posting.pdf', pdf), 'application/pdf');
  assert.equal(attachmentMimeType('posting.docx', pdf), null);
  assert.equal(attachmentMimeType('posting.pdf', Buffer.from('not a PDF')), null);
  assert.equal(attachmentMimeType('posting.txt', Buffer.from('Job description\n')), 'text/plain; charset=utf-8');
  assert.equal(attachmentMimeType('posting.txt', Buffer.from([0xff])), null);
  assert.equal(attachmentMimeType('posting.txt', Buffer.from([0])), null);
});

test('uploaded filenames cannot contain paths or response-header controls', () => {
  assert.equal(cleanAttachmentFileName('C:\\fakepath\\JD\r\n.pdf'), 'JD.pdf');
  assert.equal(cleanAttachmentFileName('../../posting.pdf'), 'posting.pdf');
});

test('caption transcripts remain UTF-8 text and never become HTML', () => {
  assert.equal(attachmentMimeType('interview.vtt', Buffer.from('WEBVTT\n\nInterviewer: Welcome.')), 'text/vtt; charset=utf-8');
  assert.equal(attachmentMimeType('interview.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nWelcome.')), 'text/plain; charset=utf-8');
  assert.equal(attachmentMimeType('interview.vtt', Buffer.from([0xff])), null);
  assert.equal(attachmentMimeType('interview.srt', Buffer.from([0])), null);
  assert.equal(attachmentMimeType('interview.html', Buffer.from('<script>alert(1)</script>')), null);
});
