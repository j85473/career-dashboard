import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobDocuments } from '../../components/JobDocuments';
import { jobAttachmentKind } from '../jobAttachmentKind';

test('legacy prep filenames are recognized and an explicit upload kind takes precedence', () => {
  for (const fileName of ['Skykit - First Round Prep - 2026-11-04.pdf', 'Skykit_Interview_Preparation.docx']) {
    assert.equal(jobAttachmentKind({ fileName }), 'prep');
    assert.equal(jobAttachmentKind({ fileName, kind: 'jd' }), 'jd');
  }
  assert.equal(jobAttachmentKind({ fileName: 'Skykit - Director of Partner-Channel Accounts.pdf' }), 'jd');
  assert.equal(jobAttachmentKind({ fileName: 'document.pdf', kind: 'prep' }), 'prep');
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
  assert.doesNotMatch(html, />document.docx<\/a>|>Skykit - First Round Prep/);
});
