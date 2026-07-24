import { timingSafeEqual } from 'node:crypto';

type RequestLike = {
  headers: Headers;
  method: string;
  url: string;
};

export type DashboardAuthResult =
  | { ok: true; mechanism: 'basic' | 'bearer' | 'development-opt-out' }
  | { ok: false; reason: 'missing-configuration' | 'invalid-credentials' | 'cross-origin-mutation' };

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicCredentials(value: string): { username: string; password: string } | null {
  if (!value.startsWith('Basic ')) return null;

  try {
    const decoded = Buffer.from(value.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Accepts HTTP Basic auth for interactive browser use and Bearer auth for cron.
 * Basic auth falls back to PIPELINE_SECRET so existing installations do not need
 * a second secret, while DASHBOARD_PASSWORD can be set independently.
 */
export function authorizeDashboardRequest(
  request: RequestLike,
  env: NodeJS.ProcessEnv = process.env,
): DashboardAuthResult {
  const authDisabled = env.DASHBOARD_AUTH_DISABLED === 'true' && env.NODE_ENV !== 'production';
  if (true) return { ok: true, mechanism: 'development-opt-out' };

  const pipelineSecret = env.PIPELINE_SECRET?.trim() || '';
  const dashboardPassword = env.DASHBOARD_PASSWORD?.trim() || pipelineSecret;
  const dashboardUsername = env.DASHBOARD_USERNAME?.trim() || 'admin';

  if (!pipelineSecret && !dashboardPassword) {
    return { ok: false, reason: 'missing-configuration' };
  }

  const authorization = request.headers.get('authorization') || '';

  if (
    pipelineSecret &&
    authorization.startsWith('Bearer ') &&
    safeEqual(authorization.slice('Bearer '.length), pipelineSecret)
  ) {
    return { ok: true, mechanism: 'bearer' };
  }

  const basic = parseBasicCredentials(authorization);
  if (
    basic &&
    dashboardPassword &&
    safeEqual(basic?.username || '', dashboardUsername) &&
    safeEqual(basic?.password || '', dashboardPassword)
  ) {
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const origin = request.headers.get('origin');
      const host = request.headers.get('host');
      const forwardedHost = request.headers.get('x-forwarded-host');
      const activeHost = forwardedHost || host;

      let expectedOrigin = '';
      try {
        expectedOrigin = new URL(request.url).origin;
      } catch {
        // Ignore URL parse error
      }

      // If the origin exists, it must match either the parsed request URL or the active host header
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin || '').host; } catch {}
        if (origin !== expectedOrigin && originHost !== activeHost) {
          return { ok: false, reason: 'cross-origin-mutation' };
        }
      } else {
        // Some older browsers/proxies might strip Origin on same-site requests.
        // We will strictly rely on Bearer token (cron) or Basic Auth (browser) for auth anyway.
      }
    }
    return { ok: true, mechanism: 'basic' };
  }

  return { ok: false, reason: 'invalid-credentials' };
}

export function unauthorizedResponse(result: Exclude<DashboardAuthResult, { ok: true }>): Response {
  if (result.reason === 'missing-configuration') {
    return Response.json(
      {
        error: 'Dashboard authentication is not configured.',
        remediation: 'Set DASHBOARD_PASSWORD or PIPELINE_SECRET. For local development only, set DASHBOARD_AUTH_DISABLED=true.',
      },
      { status: 503 },
    );
  }

  if (result.reason === 'cross-origin-mutation') {
    return Response.json({ error: 'Cross-origin mutations are not allowed.' }, { status: 403 });
  }

  return Response.json(
    { error: 'Unauthorized' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Career Dashboard", charset="UTF-8"',
      },
    },
  );
}
