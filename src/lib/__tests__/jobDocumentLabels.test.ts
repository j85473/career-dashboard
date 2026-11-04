import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobDocuments } from '../../components/JobDocuments';
import { jobAttachmentKind, newestJobAttachments } from '../jobAttachmentKind';

test('legacy prep filenames are recognized and an explicit upload kind takes precedence', () => {
  for (const fileName of ['Skykit - First Round Prep - 2026-11-04.pdf', 'Skykit_Interview_Preparation.docx']) {
    assert.equal(jobAttachmentKind({ fileName }), 'prep');
    assert.equal(jobAttachmentKind({ fileName, kind: 'jd' }), 'jd');
  }
  assert.equal(jobAttachmentKind({ fileName: 'Skykit - Director of Partner-Channel Accounts.pdf' }), 'jd');
  assert.equal(jobAttachmentKind({ fileName: 'document.pdf', kind: 'prep' }), 'prep');
});

test('the single company prep button opens the newest upload and retains older packs and every transcript', () => {
  const attachment = (id: string, kind: 'jd' | 'prep' | 'transcript', uploadedAt: string) => ({
    id, kind, uploadedAt, fileName: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 1024,
  });
  const attachments = [
    attachment('first-prep', 'prep', '2026-11-04T15:00:00Z'),
    attachment('latest-prep', 'prep', '2026-11-04T17:00:00Z'),
    attachment('middle-prep', 'prep', '2026-11-04T16:00:00Z'),
    attachment('recruiter-transcript', 'transcript', '2026-11-04T15:30:00Z'),
    attachment('manager-transcript', 'transcript', '2026-11-04T17:30:00Z'),
    attachment('jd', 'jd', '2026-11-01T15:00:00Z'),
  ];
  const html = renderToStaticMarkup(React.createElement(JobDocuments, {
    job: { id: 'sky', title: 'Channel Sales Manager', company: 'Skykit', status: 'interviewing', attachments },
  }));
  assert.match(html, /href="\/api\/jobs\/sky\/attachments\/latest-prep\?inline=1"[^>]*>Skykit interview prep<\/a>/);
  assert.equal((html.match(/>Skykit interview prep<\/a>/g) || []).length, 1);
  assert.match(html, /Older prep packs \(2\)/);
  assert.match(html, /href="\/api\/jobs\/sky\/attachments\/first-prep\?inline=1"/);
  assert.match(html, /href="\/api\/jobs\/sky\/attachments\/middle-prep\?inline=1"/);
  assert.match(html, /Interview transcripts \(2\)/);
  assert.match(html, />recruiter-transcript.pdf<\/a>/);
  assert.match(html, />manager-transcript.pdf<\/a>/);
  assert.equal(jobAttachmentKind(attachments[3]), 'transcript');
  assert.deepEqual(attachments.map(item => item.id), ['first-prep', 'latest-prep', 'middle-prep', 'recruiter-transcript', 'manager-transcript', 'jd']);
  const remaining = attachments.filter(item => item.id !== 'latest-prep' && item.kind === 'prep');
  assert.equal(newestJobAttachments(remaining)[0].id, 'middle-prep');
});

test('attachment buttons use the displayed company and document purpose while retaining original downloads', () => {
  const html = renderToStaticMarkup(React.createElement(JobDocuments, {
    job: { id: 'sky', title: 'Director of Partner/Channel Accounts', company: 'Skykit LLC', employer: 'Skykit', status: 'interviewing',
      attachments: [
        { id: 'prep', fileName: 'Skykit - First Round Prep - 2026-11-04.pdf', mimeType: 'application/pdf', sizeBytes: 1024, uploadedAt: '' },
        { id: 'jd', fileName: 'Skykit - Director of Partner-Channel Accounts.pdf', mimeType: 'application/pdf', sizeBytes: 1024, uploadedAt: '' },
        { id: 'generic', kind: 'prep', fileName: 'document.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 1024, uploadedAt: '' },
      ] },
  }));
  assert.match(html, />Skykit interview prep<\/a>/);
  assert.match(html, />Skykit job description<\/a>/);
  assert.match(html, /href="\/api\/jobs\/sky\/attachments\/prep\?inline=1"/);
  assert.match(html, /download="Skykit - First Round Prep - 2026-11-04.pdf"/);
  assert.match(html, /download="document.docx"/);
  const pdfLinks = html.match(/<a class="job-attachment-link"[^>]*aria-haspopup="dialog"[^>]*>/g) || [];
  assert.equal(pdfLinks.length, 2);
  for (const link of pdfLinks) assert.doesNotMatch(link, /target="_blank"/);
  assert.doesNotMatch(html, />Skykit - First Round Prep[^<]*<\/a>/);
  assert.match(html, /Older prep packs \(1\)/);
  assert.match(html, />document.docx<\/a>/);
});
