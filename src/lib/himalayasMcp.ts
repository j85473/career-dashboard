import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HIMALAYAS_MCP_URL = 'https://mcp.himalayas.app/mcp';

export function parseHimalayasCompanyWebsite(text: string): string | null {
  const match = text.match(/(?:^|\n)🌐\s*\*\*Website:\*\*\s*(https?:\/\/\S+)/i);
  if (!match?.[1]) return null;
  try {
    const url = new URL(match[1]);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export type HimalayasCompanyDetails = {
  slug: string;
  website: string;
  responseText: string;
};

/**
 * Read the employer website from Himalayas' public MCP. No account or OAuth is
 * required for this tool. The caller caches the result through a verified board
 * mapping to reduce repeat profile lookups while careers feeds remain live.
 */
export async function getHimalayasCompanyDetails(
  slug: string,
  endpoint = HIMALAYAS_MCP_URL,
  timeoutMs = 15_000,
): Promise<HimalayasCompanyDetails | null> {
  if (!/^[a-z0-9][a-z0-9_-]{1,120}$/i.test(slug)) return null;
  const client = new Client({ name: 'career-dashboard-employer-resolver', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    const result = await client.callTool({
      name: 'get_company_details',
      arguments: { company_slug: slug },
    }, undefined, { signal, timeout: timeoutMs });
    const content = Array.isArray(result.content)
      ? result.content as Array<{ type?: unknown; text?: unknown }>
      : [];
    const responseText = content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => String(item.text))
      .join('\n');
    const website = parseHimalayasCompanyWebsite(responseText);
    return website ? { slug, website, responseText } : null;
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
