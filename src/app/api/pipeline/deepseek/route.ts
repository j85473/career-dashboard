import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json({
    error: 'DeepSeek scoring is disabled. Use the native Antigravity scoring request endpoint.',
    nativeEndpoint: '/api/scoring/requests',
  }, { status: 410 });
}
