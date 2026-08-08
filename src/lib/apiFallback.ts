export function getSerpApiKeys(): string[] {
  return [
    process.env.SERPAPI_KEY, 
    process.env.SERPAPI_KEY_2,
    process.env.SERPAPI_LINKEDIN_KEY,
    process.env.SERPAPI_LINKEDIN_KEY_2
  ].filter(Boolean) as string[];
}

export function getRapidApiKeys(): string[] {
  const keys = [
    process.env.RAPIDAPI_KEY, 
    process.env.RAPIDAPI_KEY_2, 
    process.env.RAPIDAPI_KEY_3,
    process.env.RAPIDAPI_KEY_4,
    process.env.RAPIDAPI_KEY_5,
    process.env.RAPIDAPI_KEY_6
  ].filter(Boolean) as string[];

  if (process.env.RAPIDAPI_KEYS) {
    keys.push(...process.env.RAPIDAPI_KEYS.split(',').map(k => k.trim()).filter(Boolean));
  }

  return Array.from(new Set(keys));
}

export function getSerpApiLinkedinKeys(): string[] {
  return [
    process.env.SERPAPI_LINKEDIN_KEY, 
    process.env.SERPAPI_LINKEDIN_KEY_2,
    process.env.SERPAPI_KEY, // Fallback to main keys
    process.env.SERPAPI_KEY_2
  ].filter(Boolean) as string[];
}

let rotationIndex = 0;

/**
 * Keys are rested, never retired.
 *
 * A permanent blacklist used to live here, and it is what took ingestion down:
 * RapidAPI answers 429 for a per-minute throttle just as it does for a spent
 * monthly quota, so one busy minute retired every key until the process
 * restarted. Cooldowns are sized from what the response actually says.
 */
const cooldownsByService = new Map<string, Map<string, number>>();

/** A throttle clears in seconds; this is only the fallback when nothing says so. */
export const KEY_COOLDOWN_THROTTLE_MS = 60 * 1000;
/** A spent quota that gave no reset hint: retry tomorrow rather than never. */
export const KEY_COOLDOWN_QUOTA_MS = 24 * 60 * 60 * 1000;
/** Not subscribed is a config problem, so back off hard — but still recover. */
export const KEY_COOLDOWN_FORBIDDEN_MS = 6 * 60 * 60 * 1000;
export const KEY_COOLDOWN_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Clears all rotation state. The round-robin cursor is included so a caller
 *  starting from a known point gets a deterministic key order. */
export function resetKeyCooldowns(): void {
  cooldownsByService.clear();
  rotationIndex = 0;
}

function cooldownMsFor(response: Response, body: string): number {
  // RapidAPI reports seconds remaining in the current quota window.
  const resetHeader = response.headers.get('x-ratelimit-requests-reset')
    || response.headers.get('x-ratelimit-reset')
    || response.headers.get('retry-after');
  const resetSeconds = Number.parseInt(resetHeader || '', 10);
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return Math.min(resetSeconds * 1000, KEY_COOLDOWN_MAX_MS);
  }
  if (response.status === 403) return KEY_COOLDOWN_FORBIDDEN_MS;
  // "You have exceeded the MONTHLY quota for Requests on your current plan"
  if (/\bmonthly\b|\bquota\b/i.test(body) || response.status === 402) {
    return KEY_COOLDOWN_QUOTA_MS;
  }
  return KEY_COOLDOWN_THROTTLE_MS;
}

function describeWait(readyAt: number, now: number): string {
  const seconds = Math.max(1, Math.round((readyAt - now) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

export async function fetchWithKeyRotation(
  keys: string[],
  fetchFn: (key: string) => Promise<Response>,
  serviceName: string = 'default',
  options: { now?: () => number } = {},
): Promise<Response | null> {
  const now = options.now || (() => Date.now());
  let lastError: unknown;

  if (!cooldownsByService.has(serviceName)) {
    cooldownsByService.set(serviceName, new Map<string, number>());
  }
  const cooldowns = cooldownsByService.get(serviceName)!;

  const present = keys.filter(Boolean);
  const validKeys = present.filter((key) => (cooldowns.get(key) || 0) <= now());
  if (validKeys.length === 0) {
    if (present.length === 0) throw new Error('No API keys are configured.');
    // Name the recovery time so the stored run error is diagnosable rather than
    // the old dead end, "All configured API keys are exhausted or missing."
    const readyAt = Math.min(...present.map((key) => cooldowns.get(key) || 0));
    throw new Error(
      `All ${present.length} API keys for ${serviceName} are cooling down; next retry in ${describeWait(readyAt, now())}.`,
    );
  }

  // Round robin start index
  const startIndex = rotationIndex % validKeys.length;

  for (let i = 0; i < validKeys.length; i++) {
    const currentIndex = (startIndex + i) % validKeys.length;
    const key = validKeys[currentIndex];

    let res: Response;
    try {
      res = await fetchFn(key);
    } catch (error) {
      lastError = error;
      console.warn(`[${serviceName}] API request failed, trying next configured key...`);
      continue;
    }

    if (res.status === 429 || res.status === 402 || res.status === 403) {
      // Safe to drain: this response is discarded either way.
      const body = await res.text().catch(() => '');
      const cooldown = cooldownMsFor(res, body);
      cooldowns.set(key, now() + cooldown);
      console.warn(`[${serviceName}] key limited (${res.status}); resting it for ${describeWait(now() + cooldown, now())}.`);
      lastError = new Error(`Rate limit exceeded (${res.status})`);
      continue;
    }

    // Update rotation index for next call
    rotationIndex++;
    return res;
  }

  if (lastError) throw lastError;
  return null;
}
// PR 6 RapidAPI Key-Pool Management
