import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authorizeDashboardRequest, unauthorizedResponse } from '@/lib/apiAuth';

const PUBLIC_PATHS = new Set(['/api/health']);

export function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const result = authorizeDashboardRequest(request);
  if (!result.ok) return unauthorizedResponse(result);

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
