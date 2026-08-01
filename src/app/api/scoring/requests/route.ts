import { NextResponse } from 'next/server';

import {
  activeNativeScoringRequest,
  createNativeScoringRequest,
  latestNativeScoringRequest,
  publicNativeScoringRequest,
} from '@/lib/nativeScoringRequest';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const active = await activeNativeScoringRequest();
    const request = active || await latestNativeScoringRequest();
    return NextResponse.json(
      { request: publicNativeScoringRequest(request) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to read native scoring status',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}

export async function POST() {
  try {
    const { request, created, resumed } = await createNativeScoringRequest('dashboard');
    return NextResponse.json({
      created,
      resumed,
      request: publicNativeScoringRequest(request),
      message: created || resumed
        ? resumed
          ? 'The failed native scoring request was queued to resume preserved work.'
          : 'Native scoring request queued for the local Antigravity runner.'
        : 'A native scoring request is already active.',
    }, { status: created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({
      error: 'Failed to queue native scoring',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
