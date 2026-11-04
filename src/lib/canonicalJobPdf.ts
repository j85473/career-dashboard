import { access } from 'node:fs/promises';
import type { HTTPRequest } from 'puppeteer';
import { safeExternalFetch, assertSafeExternalNavigationUrl } from './safeExternalFetch';
import { MAX_JOB_ATTACHMENT_BYTES } from './jobAttachments';
import { looksLikeInvalidJobDescription } from './jobDescriptionQuality';

export type CanonicalPdfSubject = { sourceUrl: string; title: string };

export function validateCapturedPage(text: string, title: string) {
  if (text.trim().length < 200 || looksLikeInvalidJobDescription(text)) {
    throw new Error('The canonical page is unavailable, blocked, or has not loaded a job description.');
  }
  const words = [...new Set(title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
  const body = text.toLowerCase();
  if (words.length && words.filter(word => body.includes(word)).length < Math.ceil(words.length * .6)) {
    throw new Error('The canonical page no longer shows this job. Check the URL and try again.');
  }
}

export function validateCapturedPdf(bytes: Uint8Array): Buffer {
  if (bytes.length > MAX_JOB_ATTACHMENT_BYTES) throw new Error('The captured PDF exceeds the 10 MB attachment limit.');
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new Error('The source did not return a valid PDF.');
  return Buffer.from(bytes);
}

async function chromeExecutable(): Promise<string | undefined> {
  for (const candidate of [process.env.JD_PDF_CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* Try the next installed browser. */ }
  }
}

let activeCaptures = 0;

/** Render the canonical page itself. Stored descriptions are never an input. */
export async function captureCanonicalJobPdf(subject: CanonicalPdfSubject,
  fetchExternal = safeExternalFetch): Promise<Buffer> {
  assertSafeExternalNavigationUrl(subject.sourceUrl);
  if (activeCaptures >= 2) throw new Error('Two PDF captures are already running. Try again shortly.');
  activeCaptures++;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60_000);
  let browser: import('puppeteer').Browser | undefined;
  try {
    const { default: puppeteer } = await import('puppeteer');
    browser = await puppeteer.launch({ executablePath: await chromeExecutable(), headless: true,
      timeout: 15_000, args: ['--disable-dev-shm-usage', '--disable-background-networking'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    let originalPdf: Buffer | undefined;
    let navigationError: string | undefined;
    let requestCount = 0;
    let totalBytes = 0;
    const abortBrowser = () => { void browser?.close().catch(() => {}); };
    controller.signal.addEventListener('abort', abortBrowser, { once: true });
    const handleRequest = async (request: HTTPRequest) => {
      try {
        // Every network hop, including redirects, frames, and JS requests, uses
        // the existing public-IP-pinned transport. Chromium cannot reach LAN services.
        if (request.isNavigationRequest()) assertSafeExternalNavigationUrl(request.url());
        if (/^(?:data|blob):/i.test(request.url())) { await request.continue(); return; }
        if (controller.signal.aborted || ++requestCount > 150 || ['media', 'eventsource', 'websocket'].includes(request.resourceType())) {
          await request.abort(); return;
        }
        const method = request.method();
        if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(method)) { await request.abort(); return; }
        const headers = new Headers(request.headers());
        headers.delete('host'); headers.delete('content-length');
        const response = await fetchExternal(request.url(), {
          method, headers, body: ['POST', 'OPTIONS'].includes(method) ? request.postData() : undefined,
          redirect: 'manual', signal: controller.signal,
        }, 5, { maximumBytes: MAX_JOB_ATTACHMENT_BYTES, maximumAddressAttempts: 2 });
        const body = Buffer.from(await response.arrayBuffer());
        totalBytes += body.length;
        if (totalBytes > 40 * 1024 * 1024) throw new Error('The source page is too large to capture.');
        const mainDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (mainDocument && response.status >= 400) throw new Error(`The canonical page returned HTTP ${response.status}.`);
        if (mainDocument && (response.headers.get('content-type')?.includes('application/pdf') || body.subarray(0, 5).toString() === '%PDF-')) {
          originalPdf = validateCapturedPdf(body);
          await request.abort(); return;
        }
        const responseHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers.entries());
        const cookies = response.headers.getSetCookie();
        if (cookies.length) responseHeaders['set-cookie'] = cookies;
        // The pinned transport has already decoded compressed bytes.
        delete responseHeaders['content-encoding']; delete responseHeaders['content-length']; delete responseHeaders['transfer-encoding'];
        await request.respond({ status: response.status, headers: responseHeaders, body });
      } catch (error) {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          navigationError = error instanceof Error ? error.message : 'The canonical page could not be loaded.';
        }
        if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
      }
    };
    page.on('request', request => { void handleRequest(request); });
    try {
      await page.goto(subject.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      if (!originalPdf) throw new Error(navigationError || (error instanceof Error ? error.message : 'The source could not be loaded.'));
    }
    if (originalPdf) return originalPdf;
    if (navigationError) throw new Error(navigationError);
    await page.waitForFunction(() => (document.body?.innerText.length || 0) >= 200, { timeout: 12_000 }).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 5_000 }).catch(() => {});
    const frameTexts = await Promise.all(page.frames().map(frame => frame.evaluate(() => document.body?.innerText || '').catch(() => '')));
    validateCapturedPage(frameTexts.join('\n'), subject.title);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true,
      timeout: 15_000, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } });
    return validateCapturedPdf(pdf);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await browser?.close().catch(() => {});
    activeCaptures--;
  }
}
