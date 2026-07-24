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

export async function fetchWithKeyRotation(
  keys: string[],
  fetchFn: (key: string) => Promise<Response>
): Promise<Response | null> {
  let lastError: unknown;
  for (const key of keys) {
    if (!key) continue;
    let res: Response;
    try {
      res = await fetchFn(key);
    } catch (error) {
      lastError = error;
      console.warn('API request failed, trying next configured key...');
      continue;
    }
    if (res.status === 429 || res.status === 402 || res.status === 403) {
      console.warn('API key limit reached, trying next key...');
      lastError = new Error(`Rate limit exceeded (${res.status})`);
      continue;
    }
    return res;
  }
  if (lastError) throw lastError;
  return null;
}
// PR 6 RapidAPI Key-Pool Management
