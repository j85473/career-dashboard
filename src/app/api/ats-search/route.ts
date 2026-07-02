import { ingestJobs } from '@/lib/jobIngestion';
import { scoreJobs } from '@/lib/jobScoring';

export async function POST(request: Request) {
  const signal = request.signal;
  const body = await request.json();
  const targetAtsSlugs = body.slugs || []; // Array of { slug, platform }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (e) {
          // stream closed
        }
      };

      try {
        let ingestedCount = 0;
        sendEvent({ message: `Starting manual fetch for ${targetAtsSlugs.length} ATS boards...`, step: 'ingesting' });
        
        ingestedCount = await ingestJobs((msg) => {
          sendEvent({ message: msg, step: 'ingesting' });
        }, signal, targetAtsSlugs);
        
        if (signal.aborted) {
          sendEvent({ message: 'Search canceled.', step: 'done' });
          controller.close();
          return;
        }
        
        sendEvent({ message: `Found ${ingestedCount} new jobs. Starting local heuristic scoring...`, step: 'scoring' });
        
        const scoredCount = await scoreJobs((msg, job) => {
          if (msg.startsWith('Scored')) {
            sendEvent({ message: msg, step: 'scored', job });
          } else {
            sendEvent({ message: msg, step: 'scoring_job', job });
          }
        }, signal);
        
        sendEvent({ message: signal.aborted ? 'Process canceled.' : `Finished! Scored ${scoredCount} jobs.`, step: 'done', ingestedCount, scoredCount });
        try { controller.close(); } catch(e) {}
      } catch (error: any) {
        console.error('Manual ATS search failed:', error);
        sendEvent({ error: 'Manual ATS search failed', details: error.message });
        try { controller.close(); } catch(e) {}
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
