import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      error: 'Offline AI evaluation export is retired.',
      details: 'Use POST /api/scoring/requests or the Score Pending Jobs dashboard button.',
    },
    { status: 410 },
  );
}
