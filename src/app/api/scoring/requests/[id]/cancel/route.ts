import { NextResponse } from 'next/server';

import {
  cancelNativeScoringRequest,
  publicNativeScoringRequest,
} from '@/lib/nativeScoringRequest';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: 'Invalid scoring request ID' }, { status: 400 });
    }
    const request = await cancelNativeScoringRequest(id);
    return NextResponse.json({ request: publicNativeScoringRequest(request) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: /not found/i.test(message) ? 404 : 409 },
    );
  }
}
