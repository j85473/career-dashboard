import { NextResponse } from 'next/server';
import { runDeepseekEvaluation } from '@/lib/deepseekEvaluator';

export async function POST() {
  try {
    const res = await runDeepseekEvaluation((msg) => console.log('DeepSeek Eval:', msg));
    return NextResponse.json({ message: 'Evaluation completed successfully', details: res });
  } catch (error: any) {
    console.error('DeepSeek Evaluation API Error:', error);
    return NextResponse.json({ error: 'Failed to run DeepSeek evaluation', details: error.message }, { status: 500 });
  }
}
