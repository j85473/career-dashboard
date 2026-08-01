import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    {
      error: 'Offline AI evaluation import is retired.',
      details: 'Native Antigravity results are validated and imported by the registered scoring runner.',
    },
    { status: 410 },
  );
}
