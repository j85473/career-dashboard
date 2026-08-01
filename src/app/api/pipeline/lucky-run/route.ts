import { NextResponse } from 'next/server';

import { createNativeScoringRequest, publicNativeScoringRequest } from '@/lib/nativeScoringRequest';

export const dynamic = 'force-dynamic';

/**
 * Compatibility endpoint. Wildcard scoring is phase three of the complete
 * native workflow and is never sent to the former API evaluator.
 */
export async function POST() {
  try {
    const { request, created, resumed } = await createNativeScoringRequest('wildcard-dashboard');
    return NextResponse.json({
      created,
      resumed,
      request: publicNativeScoringRequest(request),
      message: created || resumed
        ? 'Full native scoring queued; wildcard evaluation will run after A/E import.'
        : 'A native scoring request is already active.',
    }, { status: created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to queue native wildcard processing',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
