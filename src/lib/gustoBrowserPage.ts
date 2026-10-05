import { isGustoMissingPage } from './gustoBoard';

type GustoRenderedPage = {
  content(): Promise<string>;
  locator(selector: string): { innerText(): Promise<string> };
};

/** Wait for parseable inventory/details, rather than a unique heading match. */
export async function readRenderedGustoPage<T>(
  page: GustoRenderedPage,
  parse: (html: string, visibleText: string) => T | null,
  kind: 'Board' | 'Posting',
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const [html, visibleText] = await Promise.all([page.content(), page.locator('body').innerText()]);
    if (isGustoMissingPage(visibleText)) throw new Error(`${kind} returned HTTP 404 (Gusto page not found)`);
    const result = parse(html, visibleText);
    if (result !== null) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  } while (Date.now() <= deadline);
  throw new Error(`${kind} did not render verified Gusto ${kind === 'Board' ? 'inventory or an explicit unavailable notice' : 'posting details'} within ${timeoutMs}ms`);
}
