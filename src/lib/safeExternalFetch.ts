import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions as HttpRequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

export type LookupResult = { address: string; family: number };
export type LookupFunction = (hostname: string) => Promise<LookupResult[]>;

export type PinnedTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
};

export type PinnedRequester = (target: PinnedTarget, init: RequestInit) => Promise<Response>;

export type SafeExternalFetchDependencies = {
  lookup?: LookupFunction;
  request?: PinnedRequester;
};

export type PinnedRequestOptions = HttpRequestOptions & {
  servername?: string;
  rejectUnauthorized?: boolean;
};

type ResolvedSafeUrl = {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
};

const defaultLookup: LookupFunction = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family }));
};

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6Groups(input: string): number[] | null {
  let address = input.toLowerCase().split('%')[0];
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);

  const ipv4Tail = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const octets = ipv4Tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) return null;
    const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    address = address.slice(0, -ipv4Tail.length) + replacement;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  return groups.map((group) => Number.parseInt(group, 16));
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (mapped.includes('.')) return isPublicIpv4(mapped);
  }

  const groups = parseIpv6Groups(normalized);
  if (groups === null) return false;

  // Publicly routable global-unicast space is 2000::/3. Documentation space
  // within that range must still be rejected.
  const globalUnicast = groups[0] >= 0x2000 && groups[0] <= 0x3fff;
  const documentation = groups[0] === 0x2001 && groups[1] === 0x0db8;
  return globalUnicast && !documentation;
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

async function resolveSafeExternalUrl(
  input: string | URL,
  lookup: LookupFunction,
): Promise<ResolvedSafeUrl> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not allowed');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Non-standard URL ports are not allowed');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan')
  ) {
    throw new Error('Local and internal hostnames are not allowed');
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicIpAddress(hostname)) throw new Error('Private or reserved IP addresses are not allowed');
    return { url, addresses: [{ address: hostname, family: literalFamily as 4 | 6 }] };
  }

  let results: LookupResult[];
  try {
    results = await lookup(hostname);
  } catch {
    throw new Error('URL hostname could not be resolved');
  }

  const addresses = results.map(({ address }) => {
    const normalizedAddress = address.replace(/^\[|\]$/g, '');
    return { address: normalizedAddress, family: isIP(normalizedAddress) as 0 | 4 | 6 };
  });
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => family === 0 || !isPublicIpAddress(address))
  ) {
    throw new Error('URL hostname resolves to a private or reserved address');
  }

  return {
    url,
    addresses: addresses as Array<{ address: string; family: 4 | 6 }>,
  };
}

export async function assertSafeExternalUrl(
  input: string | URL,
  lookup: LookupFunction = defaultLookup,
): Promise<URL> {
  return (await resolveSafeExternalUrl(input, lookup)).url;
}

function headersForPinnedRequest(url: URL, input: HeadersInit | undefined): Headers {
  const headers = new Headers(input);
  // Request the uncompressed representation because this transport intentionally
  // does not perform content-decoding on the response stream.
  headers.set('accept-encoding', 'identity');
  headers.set('host', url.host);
  headers.delete('connection');
  headers.delete('transfer-encoding');
  return headers;
}

/** Exposed for deterministic tests of IP pinning and TLS hostname validation. */
export function buildPinnedRequestOptions(target: PinnedTarget, init: RequestInit = {}): PinnedRequestOptions {
  const hostname = target.url.hostname.replace(/^\[|\]$/g, '');
  const headers = headersForPinnedRequest(target.url, init.headers);
  const options: PinnedRequestOptions = {
    protocol: target.url.protocol,
    hostname: target.address,
    family: target.family,
    port: target.url.port || (target.url.protocol === 'https:' ? 443 : 80),
    method: init.method || 'GET',
    path: `${target.url.pathname}${target.url.search}`,
    headers: Object.fromEntries(headers.entries()),
    signal: init.signal || undefined,
  };

  // Connect to the pinned IP, but validate the certificate and send SNI for the
  // original hostname. IP-literal URLs are validated against their IP instead.
  if (target.url.protocol === 'https:' && isIP(hostname) === 0) {
    Object.assign(options, { servername: hostname, rejectUnauthorized: true });
  }
  return options;
}

async function requestBody(init: RequestInit, headers: Headers): Promise<Buffer | undefined> {
  if (init.body == null) return undefined;
  const bodyResponse = new Response(init.body);
  const inferredContentType = bodyResponse.headers.get('content-type');
  if (inferredContentType && !headers.has('content-type')) headers.set('content-type', inferredContentType);
  return Buffer.from(await bodyResponse.arrayBuffer());
}

const requestPinnedAddress: PinnedRequester = async (target, init) => {
  const headers = headersForPinnedRequest(target.url, init.headers);
  const body = await requestBody(init, headers);
  if (body && !headers.has('content-length')) headers.set('content-length', String(body.byteLength));
  const requestOptions = buildPinnedRequestOptions(target, { ...init, headers });
  const requestFn = target.url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    const request = requestFn(requestOptions, (incoming) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      incoming.on('data', (chunk: Buffer | Uint8Array | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          incoming.destroy(new Error(`External response exceeds ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(buffer);
      });
      incoming.once('error', reject);
      incoming.once('aborted', () => reject(new Error('External response was aborted')));
      incoming.once('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        const status = incoming.statusCode || 502;
        const responseBody = [204, 205, 304].includes(status)
          ? null
          : new Uint8Array(Buffer.concat(chunks));
        const response = new Response(responseBody, {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        });
        Object.defineProperty(response, 'url', { value: target.url.toString() });
        resolve(response);
      });
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
};

function preserveResponseUrl(response: Response, url: URL): Response {
  if (response.url) return response;
  try {
    Object.defineProperty(response, 'url', { value: url.toString() });
  } catch {
    // Native responses already expose a URL. This fallback only matters for a
    // custom/injected transport whose Response implementation is immutable.
  }
  return response;
}

/**
 * Fetch an external URL while validating and IP-pinning the initial target and
 * every redirect. DNS is resolved exactly once per hop, then the socket connects
 * to one of those validated public addresses.
 */
export async function safeExternalFetch(
  input: string | URL,
  init: RequestInit = {},
  maxRedirects = 5,
  dependencies: SafeExternalFetchDependencies = {},
): Promise<Response> {
  const lookup = dependencies.lookup || defaultLookup;
  const requester = dependencies.request || requestPinnedAddress;
  let current = await resolveSafeExternalUrl(input, lookup);
  let currentInit: RequestInit = { ...init, redirect: 'manual' };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    let response: Response | undefined;
    let lastConnectionError: unknown;
    for (const address of current.addresses) {
      try {
        response = await requester({ url: current.url, ...address }, currentInit);
        break;
      } catch (error) {
        lastConnectionError = error;
        if (currentInit.signal?.aborted) throw error;
      }
    }
    if (!response) {
      throw lastConnectionError instanceof Error
        ? lastConnectionError
        : new Error('Unable to connect to a validated external address');
    }
    if (!REDIRECT_STATUSES.has(response.status)) return preserveResponseUrl(response, current.url);

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount === maxRedirects) throw new Error('Too many redirects');

    await response.body?.cancel();
    const previousOrigin = current.url.origin;
    current = await resolveSafeExternalUrl(new URL(location, current.url), lookup);

    const headers = new Headers(currentInit.headers);
    if (current.url.origin !== previousOrigin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && currentInit.method?.toUpperCase() === 'POST')
    ) {
      headers.delete('content-type');
      headers.delete('content-length');
      currentInit = { ...currentInit, method: 'GET', body: undefined, headers, redirect: 'manual' };
    } else {
      currentInit = { ...currentInit, headers, redirect: 'manual' };
    }
  }

  throw new Error('Too many redirects');
}
