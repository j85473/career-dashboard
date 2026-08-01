import { NextResponse } from 'next/server';

import { createNativeScoringRequest, publicNativeScoringRequest } from '@/lib/nativeScoringRequest';

export const dynamic = 'force-dynamic';

/**
 * Compatibility endpoint for the old Context button. Context updates are now
 * always phase one of the full native Antigravity workflow.
 */
export async function POST() {
  try {
    const { request, created, resumed } = await createNativeScoringRequest('context-dashboard');
    return NextResponse.json({
      created,
      resumed,
      request: publicNativeScoringRequest(request),
      message: created || resumed
        ? 'Full native scoring queued; negative-only context feedback will run first.'
        : 'A native scoring request is already active.',
    }, { status: created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to queue native context processing',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
