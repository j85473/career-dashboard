import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import sharp from 'sharp';

// Run against a local production build (with an unusable DATABASE_URL):
// node --import tsx --test tests/browser/pdfDocumentViewer.test.ts
// Set PDF_PREVIEW_WEBKIT_EXECUTABLE to also check an installed WebKit build.
const baseUrl = process.env.PDF_PREVIEW_TEST_URL || 'http://127.0.0.1:3107';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'Use a local test server.');

function fixturePdf() {
  const stream = (text: string) => {
    const data = `BT /F1 24 Tf 60 700 Td (${text}) Tj ET`;
    return `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [8 0 R] >>',
    stream('Original white PDF page 1'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream('Original white PDF page 2'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Link /Rect [60 680 400 730] /Border [0 0 0] /A << /S /URI /URI (https://meeting.example/call) >> >>',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

const engines = ['chromium', ...(process.env.PDF_PREVIEW_WEBKIT_EXECUTABLE ? ['webkit'] : [])];
for (const engine of engines) {
  test(`${engine}: zoomed-out PDFs have black surrounds, original white pages, text and links`, async () => {
    const browser = engine === 'chromium'
      ? await chromium.launch({ channel: 'chrome', headless: true })
      : await webkit.launch({ executablePath: process.env.PDF_PREVIEW_WEBKIT_EXECUTABLE, headless: true });
    try {
      const originalPdf = fixturePdf();
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
      const page = await context.newPage(); const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.includes('/attachments/')) return route.fulfill({ contentType: 'application/pdf', body: originalPdf });
        if (url.pathname === '/api/jobs') return route.fulfill({ json: {
          jobs: [{ id: 'job', title: 'Sales Manager', company: 'Employer', status: 'applied',
            attachments: [{ id: 'pdf', fileName: 'prep.pdf', kind: 'prep', mimeType: 'application/pdf', sizeBytes: originalPdf.length, uploadedAt: '' }] }],
          pagination: { page: 1, total: 1, hasMore: false, limit: 48 }, atsOptions: [],
        } });
        if (url.pathname === '/api/pipeline/status') return route.fulfill({ json: { isRunning: false, schedulePaused: true } });
        return route.fulfill({ status: 404, json: { error: 'Not found' } });
      });
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: 'Employer interview prep', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Employer interview prep', exact: true });
      await dialog.locator('.textLayer').filter({ hasText: 'Original white PDF page 1' }).waitFor();
      const meeting = dialog.locator('a[href="https://meeting.example/call"]');
      assert.equal(await meeting.getAttribute('target'), '_blank');
      assert.ok((await meeting.getAttribute('rel'))?.includes('noopener'));
      await dialog.getByRole('combobox', { name: 'PDF zoom', exact: true }).selectOption('50');
      await page.waitForFunction(() => document.querySelector('.pdfViewer .page')!.getBoundingClientRect().width < 450);
      const surround = dialog.locator('.pdf-preview-scroll');
      const { data, info } = await sharp(await surround.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
      assert.deepEqual(pixel(5, 100), [0, 0, 0]);
      assert.deepEqual(pixel(Math.floor(info.width / 2), 100), [255, 255, 255]);
      assert.equal(await dialog.locator('.pdfViewer .page').count(), 2);
      await dialog.getByRole('button', { name: 'Next PDF page', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pdf-preview-page-count')?.textContent === '2 / 2');
      await page.setViewportSize({ width: 390, height: 844 });
      await dialog.getByRole('button', { name: 'Fit width', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pdfViewer .page')!.getBoundingClientRect().width <= 390);
      assert.equal(await surround.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(0, 0, 0)');
      await dialog.getByRole('button', { name: 'Close document preview' }).click();
      assert.equal(context.pages().length, 1);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
