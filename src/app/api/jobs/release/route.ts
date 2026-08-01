import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    error: 'Unsafe global lease release is retired.',
    details: 'Use npm run scoring:release for manifest-aware dry-run and explicit release.',
  }, { status: 410 });
}
