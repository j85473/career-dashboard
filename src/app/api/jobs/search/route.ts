import { ingestJobs } from '@/lib/jobIngestion';
import { scoreJobs } from '@/lib/jobScoring';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request) {
  const signal = request.signal;
  const { searchParams } = new URL(request.url);
  const onlyScore = searchParams.get('onlyScore') === 'true';

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
        
        if (!onlyScore) {
          sendEvent({ message: 'Triggering ATS Discovery in the background...', step: 'discovery' });
          fetch(new URL('/api/ats-companies/discover', request.url).toString(), { method: 'POST' }).catch(() => {});
          
          sendEvent({ message: 'Starting auto-search engines...', step: 'ingesting' });
          ingestedCount = await ingestJobs((msg) => {
            sendEvent({ message: msg, step: 'ingesting' });
          }, signal);
          
          if (signal.aborted) {
            sendEvent({ message: 'Search canceled.', step: 'done' });
            controller.close();
            return;
          }
          sendEvent({ message: `Found ${ingestedCount} new jobs. Starting local heuristic scoring...`, step: 'scoring' });
        } else {
          sendEvent({ message: `Starting local heuristic scoring for queued jobs...`, step: 'scoring' });
        }
        
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
        console.error('Auto search failed:', error);
        sendEvent({ error: 'Auto search failed', details: error.message });
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || '';
  
  if (!q.trim()) {
    return new Response(JSON.stringify({ jobs: [] }), { headers: { 'Content-Type': 'application/json' } });
  }

  const searchTerms = q.split(' ').filter(Boolean);

  const jobs = await prisma.job.findMany({
    where: {
      AND: searchTerms.map(term => ({
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { company: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
          { source: { contains: term, mode: 'insensitive' } },
        ]
      }))
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: 50
  });

  return new Response(JSON.stringify({ jobs }), { headers: { 'Content-Type': 'application/json' } });
}
