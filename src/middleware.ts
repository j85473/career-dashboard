import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isPipelineRoute = (pathname.startsWith('/api/pipeline') && pathname !== '/api/pipeline/status') || pathname.startsWith('/api/jobs/batch-');
  
  if (isPipelineRoute) {
    const authHeader = request.headers.get('authorization');
    const secret = process.env.PIPELINE_SECRET;
    
    // Enforce if PIPELINE_SECRET is configured
    if (secret && authHeader !== `Bearer ${secret}`) {
      return new NextResponse(
        JSON.stringify({ success: false, message: 'Unauthorized' }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/pipeline/:path*', '/api/jobs/batch-:path*'],
}
