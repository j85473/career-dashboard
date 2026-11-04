import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { attachmentMimeType } from '../../src/lib/jobAttachments';

// Run against a local production build with an unusable DATABASE_URL.
const baseUrl = process.env.PDF_PREVIEW_TEST_URL || 'http://127.0.0.1:3107';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname));

function pdf(text: string) {
  const content = `BT /F1 24 Tf 60 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let result = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}

test('multiple prep packs keep one newest shortcut, preserve history, and support multiple transcript previews', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    type Attachment = { id: string; kind: string; fileName: string; uploadedAt: string; mimeType: string; sizeBytes: number };
    let sequence = 0;
    let attachments: Attachment[] = [
      { id: 'old-first', kind: 'prep', fileName: 'Round one.pdf', uploadedAt: '2026-11-04T14:00:00Z', mimeType: 'application/pdf', sizeBytes: 100 },
      { id: 'old-second', kind: 'prep', fileName: 'Round two.pdf', uploadedAt: '2026-11-04T15:00:00Z', mimeType: 'application/pdf', sizeBytes: 100 },
    ];
    const files = new Map([['old-first', pdf('Prep old first')], ['old-second', pdf('Prep old second')]]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/api/jobs') return route.fulfill({ json: {
        jobs: [{ id: 'job', title: 'Sales Manager', company: 'Employer', status: 'applied', attachments }],
        pagination: { page: 1, total: 1, hasMore: false, limit: 48 }, atsOptions: [],
      } });
      if (url.pathname === '/api/pipeline/status') return route.fulfill({ json: { isRunning: false, schedulePaused: true } });
      if (url.pathname === '/api/jobs/job/attachments' && request.method() === 'POST') {
        const form = await new Request(request.url(), { method: 'POST', headers: request.headers(), body: new Uint8Array(request.postDataBuffer()!) }).formData();
        const file = form.get('file') as File; const bytes = Buffer.from(await file.arrayBuffer());
        const mimeType = attachmentMimeType(file.name, bytes);
        if (!mimeType) return route.fulfill({ status: 400, json: { error: 'Unsupported document.' } });
        const attachment = { id: `new-${++sequence}`, kind: String(form.get('kind')), fileName: file.name,
          uploadedAt: new Date(Date.parse('2026-11-04T18:00:00Z') + sequence).toISOString(), mimeType, sizeBytes: bytes.length };
        attachments.push(attachment); files.set(attachment.id, bytes);
        return route.fulfill({ status: 201, json: { attachment, attachments } });
      }
      if (url.pathname.startsWith('/api/jobs/job/attachments/')) {
        const id = url.pathname.split('/').at(-1)!;
        if (request.method() === 'DELETE') { attachments = attachments.filter(item => item.id !== id); return route.fulfill({ json: { removed: true } }); }
        return route.fulfill({ body: files.get(id), contentType: attachments.find(item => item.id === id)?.mimeType });
      }
      return route.fulfill({ status: 404, json: { error: 'Not found' } });
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const prepLink = page.getByRole('link', { name: 'Employer interview prep', exact: true });
    assert.ok((await prepLink.getAttribute('href'))?.includes('old-second'));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach prep pack', exact: true }).click();
    const picker = await chooser; assert.equal(picker.isMultiple(), true);
    await picker.setFiles(['first', 'second', 'third'].map(name => ({ name: `Pack ${name}.pdf`, mimeType: 'application/pdf', buffer: pdf(`Prep ${name}`) })));
    await page.locator('.job-document-history summary').filter({ hasText: 'Older prep packs (4)' }).waitFor();
    assert.equal(await prepLink.count(), 1);
    await prepLink.click();
    let dialog = page.getByRole('dialog', { name: 'Employer interview prep', exact: true });
    await dialog.locator('.textLayer').filter({ hasText: 'Prep third' }).waitFor();
    await dialog.getByRole('button', { name: 'Close document preview' }).click();
    await page.locator('.job-document-history summary').click();
    assert.equal(await page.getByRole('link', { name: 'Round one.pdf', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Remove Pack third.pdf from Sales Manager', exact: true }).click();
    await page.getByRole('button', { name: 'Remove document', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.job-document-list .job-attachment-link')?.getAttribute('href')?.includes('new-2'));
    await prepLink.click(); dialog = page.getByRole('dialog', { name: 'Employer interview prep', exact: true });
    await dialog.locator('.textLayer').filter({ hasText: 'Prep second' }).waitFor();
    await dialog.getByRole('button', { name: 'Close document preview' }).click();
    const transcriptText = 'Recruiter: Welcome.\n<script>window.transcriptExecuted=true</script>';
    const transcripts = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach transcripts', exact: true }).click();
    await (await transcripts).setFiles([
      { name: 'Recruiter.txt', mimeType: 'text/plain', buffer: Buffer.from(transcriptText) },
      { name: 'Manager.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\nManager: Welcome.') },
      { name: 'Final.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nFinal interview.') },
    ]);
    await page.getByText('Interview transcripts (3)', { exact: true }).waitFor();
    for (const name of ['Recruiter.txt', 'Manager.vtt', 'Final.srt']) assert.equal(await page.getByRole('link', { name, exact: true }).count(), 1);
    await page.getByRole('link', { name: 'Recruiter.txt', exact: true }).click();
    const transcript = page.getByRole('dialog', { name: 'Employer interview transcript', exact: true });
    await transcript.locator('pre').waitFor(); assert.equal(await transcript.locator('pre').textContent(), transcriptText);
    assert.equal(await transcript.locator('.job-document-text-viewer').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(0, 0, 0)');
    assert.equal(await page.evaluate(() => Reflect.get(window, 'transcriptExecuted')), undefined);
    assert.equal(attachments.filter(item => item.kind === 'transcript').length, 3);
    assert.equal(attachments.filter(item => item.kind === 'prep').length, 4);
    await transcript.getByRole('button', { name: 'Close document preview' }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Interview transcripts (3)', { exact: true }).waitFor();
    assert.ok((await prepLink.getAttribute('href'))?.includes('new-2'));
    assert.equal(await page.getByRole('link', { name: 'Recruiter.txt', exact: true }).count(), 1);
    if (process.env.DOCUMENTS_SCREENSHOT_PATH) await page.locator('.job-documents').screenshot({ path: process.env.DOCUMENTS_SCREENSHOT_PATH });
    assert.equal(context.pages().length, 1); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
