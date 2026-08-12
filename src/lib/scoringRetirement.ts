import { NextResponse } from 'next/server';

export function nativeScoringRetiredResponse() {
  return NextResponse.json({
    error: 'Native Agy scoring is permanently retired.',
    replacement: 'Use the manual Aim/Experience export, preview, approval, and atomic import workflow.',
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}
