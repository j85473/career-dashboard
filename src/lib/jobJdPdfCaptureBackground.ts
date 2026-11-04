import { after } from 'next/server';
import { runJobJdPdfCapture } from './jobJdPdfCapture';

export function scheduleJobJdPdfCapture(jobId: string, attemptId: string) {
  after(async () => {
    try { await runJobJdPdfCapture(jobId, attemptId); }
    catch (error) { console.error('JD PDF capture interrupted:', error); }
  });
}
