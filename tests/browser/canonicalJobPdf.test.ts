import assert from 'node:assert/strict';
import test from 'node:test';
import { captureCanonicalJobPdf } from '../../src/lib/canonicalJobPdf';
import { extractPdfText } from '../../src/lib/pdfText';

// Run explicitly with an installed Chrome:
// node --import tsx --test tests/browser/canonicalJobPdf.test.ts
test('canonical URL redirects, live scripts, and styles render into a source-page PDF', async () => {
  const requested = new Set<string>();
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/job.css"></head>
    <body><h1>Channel Sales Manager</h1><div id="posting">Loading…</div><script>
      fetch('/job-data').then(response => response.json()).then(job => {
        document.getElementById('posting').textContent = job.description;
      });
    </script></body></html>`;
  const liveText = 'LIVE CANONICAL PAGE. Responsibilities include developing channel partners, working with distributors, planning territory growth, and supporting field sales. '.repeat(8);
  const pdf = await captureCanonicalJobPdf({ sourceUrl: 'https://canonical.example/jobs/42', title: 'Channel Sales Manager' }, async input => {
    const url = String(input); requested.add(url);
    if (url === 'https://canonical.example/jobs/42') return new Response(null, { status: 302, headers: { location: 'https://employer.example/job/42' } });
    if (url.endsWith('/job/42')) return new Response(html, { headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/job.css')) return new Response('body { font: 16px sans-serif; color: #123456; }', { headers: { 'content-type': 'text/css' } });
    if (url.endsWith('/job-data')) return Response.json({ description: liveText });
    return new Response('', { status: 404 });
  });
  assert.ok(requested.has('https://canonical.example/jobs/42'));
  assert.ok(requested.has('https://employer.example/job-data'));
  assert.ok(requested.has('https://employer.example/job.css'));
  const text = await extractPdfText(pdf);
  assert.match(text, /LIVE CANONICAL PAGE/);
  assert.match(text, /Channel Sales Manager/);
  assert.doesNotMatch(text, /Loading…/);
});

test('a source PDF is downloaded unchanged even through a canonical redirect', async () => {
  const original = Buffer.from('%PDF-1.7\nORIGINAL SOURCE PDF BYTES');
  const pdf = await captureCanonicalJobPdf({ sourceUrl: 'https://canonical.example/document', title: 'Sales Manager' }, async input => {
    return String(input).endsWith('/document')
      ? new Response(null, { status: 302, headers: { location: 'https://employer.example/original.pdf' } })
      : new Response(original, { headers: { 'content-type': 'application/pdf' } });
  });
  assert.deepEqual(pdf, original);
});

test('a canonical redirect cannot make the browser navigate to a private service', async () => {
  let privateReads = 0;
  await assert.rejects(captureCanonicalJobPdf({ sourceUrl: 'https://canonical.example/job', title: 'Sales Manager' }, async input => {
    if (String(input).includes('127.0.0.1')) privateReads++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  }), /Private or reserved IP/);
  assert.equal(privateReads, 0);
});

test('HTTP access failures do not become PDF attachments', async () => {
  await assert.rejects(captureCanonicalJobPdf({ sourceUrl: 'https://canonical.example/job', title: 'Sales Manager' },
    async () => new Response('Access denied', { status: 403 })), /HTTP 403/);
});
