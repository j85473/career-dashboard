import { NextResponse } from 'next/server';
import { markTimedOutPipeline } from '@/lib/pipelineState';

export async function GET() {
  try {
    return NextResponse.json(markTimedOutPipeline());
  } catch {
    return NextResponse.json(
      { isRunning: false, currentStep: 'Error', stepProgress: 'Unable to read pipeline state.' },
      { status: 500 },
    );
  }
}
