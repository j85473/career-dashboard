export const DISCOVERY_BOT = 'CareerDashboardDiscovery';
export const DISCOVERY_USER_AGENT = `${DISCOVERY_BOT}/1.0 (public ATS board discovery)`;
type Rule = { allow: boolean; path: string };
export type DiscoveryRobotsPolicy = { rules: Rule[]; crawlDelayMs: number };

function normalizedOctets(value: string): string {
  return value.replace(/[^\x21-\x7e]/gu, character => encodeURIComponent(character))
    .replace(/%[0-9a-f]{2}/gi, octet => {
      const character = String.fromCharCode(Number.parseInt(octet.slice(1), 16));
      return /^[a-z0-9._~-]$/i.test(character) ? character : octet.toUpperCase();
    });
}

/** Merge matching groups, fall back to *, and retain crawl-delay as a courtesy. */
export function parseDiscoveryRobots(text: string): DiscoveryRobotsPolicy {
  const groups: Array<{ agents: string[]; rules: Rule[]; delay: number; started: boolean }> = [];
  let current: typeof groups[number] | undefined;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.split('#', 1)[0].trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.started) {
        current = { agents: [], rules: [], delay: 0, started: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.started = true;
      if (value.startsWith('/')) current.rules.push({ allow: key === 'allow', path: normalizedOctets(value) });
    } else if (current && key === 'crawl-delay') {
      current.started = true;
      if (/^\d+(?:\.\d+)?$/.test(value)) current.delay = Math.max(current.delay, Math.ceil(Number(value) * 1000));
    }
  }
  const explicit = groups.filter(group => group.agents.includes(DISCOVERY_BOT.toLowerCase()));
  const matching = explicit.length ? explicit : groups.filter(group => group.agents.includes('*'));
  return { rules: matching.flatMap(group => group.rules), crawlDelayMs: Math.max(0, ...matching.map(group => group.delay)) };
}

export function discoveryRobotsAllows(policy: DiscoveryRobotsPolicy, value: string): boolean {
  const url = new URL(value);
  const path = normalizedOctets(url.pathname + url.search);
  let length = -1;
  let allowed = true;
  for (const rule of policy.rules) {
    const terminal = rule.path.endsWith('$');
    const pattern = terminal ? rule.path.slice(0, -1) : rule.path;
    // Literal chunks avoid backtracking regular expressions built from an
    // untrusted robots file containing arbitrarily many wildcard operators.
    const chunks = pattern.split('*');
    if (!path.startsWith(chunks[0])) continue;
    let cursor = chunks[0].length;
    let matches = true;
    for (let index = 1; index < chunks.length; index++) {
      const chunk = chunks[index];
      const position = terminal && index === chunks.length - 1 ? path.length - chunk.length : path.indexOf(chunk, cursor);
      if (position < cursor || !path.startsWith(chunk, position)) { matches = false; break; }
      cursor = position + chunk.length;
    }
    if (!matches || terminal && cursor !== path.length) continue;
    const specificity = Buffer.byteLength(pattern.replaceAll('*', ''));
    if (specificity > length || specificity === length && rule.allow) {
      length = specificity;
      allowed = rule.allow;
    }
  }
  return allowed;
}
