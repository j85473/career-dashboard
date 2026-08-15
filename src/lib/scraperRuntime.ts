/**
 * Shared runtime for the two headless-browser scrapers (CareerForce, Dejobs).
 *
 * Both used to run until an external SIGKILL cut them off mid-page, which
 * recorded a hard failure and eventually opened the provider circuit — Dejobs
 * sat circuit-open for three days that way. A scraper that runs out of time has
 * not failed; it has finished early. These helpers make that the normal path.
 */

export type ScraperBudget = {
  /** True once the run should stop taking on new work. */
  expired: () => boolean;
  remainingMs: () => number;
  elapsedMs: () => number;
};

/** Default graceful budget. The parent's kill timer sits well above this. */
export const DEFAULT_SCRAPER_BUDGET_MS = 15 * 60 * 1000;

export function scraperBudgetFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): ScraperBudget {
  const configured = Number.parseInt(environment.SCRAPER_BUDGET_MS || '', 10);
  const budgetMs = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SCRAPER_BUDGET_MS;
  const startedAt = now();
  return {
    expired: () => now() - startedAt >= budgetMs,
    remainingMs: () => Math.max(0, budgetMs - (now() - startedAt)),
    elapsedMs: () => now() - startedAt,
  };
}

export type ScraperCounts = {
  seen: number;
  inserted: number;
  duplicates: number;
  filtered: number;
  processingErrors: number;
};

export function emptyScraperCounts(): ScraperCounts {
  return { seen: 0, inserted: 0, duplicates: 0, filtered: 0, processingErrors: 0 };
}

/**
 * The line the parent parses. `budgetExhausted` distinguishes "there was nothing
 * more to take" from "time ran out", so a truncated run reads as an early finish
 * rather than a provider fault.
 */
export function ingestionSummaryLine(
  counts: ScraperCounts,
  budgetExhausted: boolean,
): string {
  return `INGESTION_SUMMARY ${JSON.stringify({ ...counts, budgetExhausted })}`;
}

type ResolverPage = {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  url: () => string;
  close: () => Promise<void>;
};

type ResolverBrowser = { newPage: () => Promise<ResolverPage> };

/**
 * Follows a dejobs/jobsyn listing through to the employer's real posting URL.
 *
 * This is the point of running a browser at all: the shim URL is useless to
 * store. The page is created once and reused, rather than opened and closed for
 * every card as it was before.
 */
export class ApplyRedirectResolver {
  private page: ResolverPage | null = null;

  constructor(
    private readonly browser: ResolverBrowser,
    private readonly log: (message: string) => void = () => {},
    private readonly hydrationDelayMs = 3000,
  ) {}

  async resolve(listingUrl: string): Promise<string> {
    try {
      if (!this.page) this.page = await this.browser.newPage();
      const page = this.page;
      await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise((resolve) => setTimeout(resolve, this.hydrationDelayMs));

      const applyHref = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const button = links.find((anchor) => {
          try {
            const host = new URL(anchor.href).hostname.toLowerCase();
            if (host === 'jobsyn.org' || host.endsWith('.jobsyn.org')) return true;
          } catch { /* a malformed href is simply not the apply link */ }
          return Boolean(anchor.innerText && anchor.innerText.toLowerCase().includes('apply now'));
        });
        return button ? button.href : null;
      });

      if (!applyHref) {
        this.log(`Could not find an apply button on ${listingUrl}`);
        return listingUrl;
      }
      await page.goto(applyHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // The apply link usually bounces again through a JS redirect.
      await new Promise((resolve) => setTimeout(resolve, this.hydrationDelayMs));
      return page.url();
    } catch (error) {
      this.log(`Error resolving ${listingUrl}: ${error instanceof Error ? error.message : String(error)}`);
      // A page left mid-navigation is not reusable.
      await this.dispose();
      return listingUrl;
    }
  }

  async dispose(): Promise<void> {
    const page = this.page;
    this.page = null;
    if (page) await page.close().catch(() => {});
  }
}
