/** Parse an absolute HTTP(S) URL without treating arbitrary text as a host match. */
export function parseHttpUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** Match an exact hostname or one of its subdomains. */
export function hostnameMatches(hostname: string, domain: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
  const normalizedDomain = domain.toLowerCase().replace(/\.$/, '');
  return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
}

export function urlMatchesAnyHost(
  value: string | null | undefined,
  domains: readonly string[],
): boolean {
  const parsed = parseHttpUrl(value);
  return parsed !== null && domains.some((domain) => hostnameMatches(parsed.hostname, domain));
}
