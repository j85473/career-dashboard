import { NextResponse } from "next/server";
import { ingestJobs } from "@/lib/jobIngestion";
import { runLuckyEvaluation } from "@/lib/luckyEvaluator";
import { scoreJobs } from '@/lib/jobScoring';
import { prisma } from "@/lib/prisma";
import { tryAcquirePipelineLock, updatePipelineState } from '@/lib/pipelineState';
import { POST as jdSubmitPost } from '../../jobs/batch-jd-submit/route';

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const WILDCARD_QUERY_POOL = [
  'strategy', 'operations', 'growth', 'partnerships', 'enablement', 'innovation',
  'ventures', 'ecosystems', 'program management', 'market development',
  'commercial strategy', 'business operations', 'special projects', 'alliances',
  'customer strategy', 'revenue operations', 'channel strategy', 'transformation',
];
async function processPipeline(releaseLock: () => void) {
  try {
    const runStartedAt = new Date();
    updatePipelineState({ isRunning: true, currentStep: "I'm Feeling Lucky", stepProgress: "Starting I'm Feeling Lucky Pipeline..." });

    // Fetch previously used queries to avoid repetition
    const usedQueriesRecords = await prisma.usedWildcardQuery.findMany({ select: { query: true } });
    const usedQueries = usedQueriesRecords.map(r => r.query);
    updatePipelineState({ stepProgress: "Selecting wildcard search rotation..." });
    const used = new Set(usedQueries.map((query) => query.toLowerCase()));
    const unused = WILDCARD_QUERY_POOL.filter((query) => !used.has(query.toLowerCase()));
    const dayIndex = Math.floor(Date.now() / 86_400_000) % WILDCARD_QUERY_POOL.length;
    const rotated = [...WILDCARD_QUERY_POOL.slice(dayIndex), ...WILDCARD_QUERY_POOL.slice(0, dayIndex)];
    const queries = [...unused, ...rotated.filter((query) => !unused.includes(query))].slice(0, 3);

    updatePipelineState({ stepProgress: `Generated Queries: ${queries.join(', ')}` });

    // Save newly generated queries to avoid repeating them tomorrow
    if (queries.length > 0) {
      try {
        await prisma.usedWildcardQuery.createMany({
          data: queries.map(q => ({ query: q })),
          skipDuplicates: true
        });
      } catch (e) {
        console.error("Failed to save used queries", e);
      }
    }

    // Run ingestion for each query
    let totalIngested = 0;
    for (const query of queries) {
      updatePipelineState({ stepProgress: `Running ingestion for query: "${query}"...` });
      const numIngested = await ingestJobs((msg) => {
        updatePipelineState({ stepProgress: msg });
      }, undefined, undefined, query, 'pending_af', true);
      totalIngested += numIngested;
    }

    updatePipelineState({ stepProgress: `Ingested ${totalIngested} new wildcard jobs. Extracting JDs...` });

    // 2. Loop JD Extraction
    let jdLoopCount = 0;
    let initialNeedsJdCount = -1;
    while (true) {
      const needsJdCount = await prisma.job.count({ 
        where: { scoringStatus: 'needs_jd', jdBatchId: null, status: { in: ['pending_af', 'inbox'] }, scoreAttempts: { lt: 3 } }
      });
      const processingJdCount = await prisma.job.count({
        where: { scoringStatus: 'needs_jd', jdBatchId: { not: null }, status: { in: ['pending_af', 'inbox'] } }
      });

      const currentTotal = needsJdCount + processingJdCount;
      if (initialNeedsJdCount === -1 || currentTotal > initialNeedsJdCount) initialNeedsJdCount = currentTotal;
      const processed = initialNeedsJdCount - currentTotal;

      if (needsJdCount === 0 && processingJdCount === 0) {
        break; // Done with JD Extraction
      }
      if (jdLoopCount > 60) {
        console.warn('JD Extraction loop timed out after 5 minutes.');
        break; // Prevent infinite loop if jobs get stuck in processing
      }

      updatePipelineState({ stepProgress: `[Processed: ${processed}] JD Extraction: ${needsJdCount} queued, ${processingJdCount} processing...` });

      if (needsJdCount > 0) {
        const req = new Request('https://internal-pipeline/api/jobs/batch-jd-submit', { method: 'POST' });
        await jdSubmitPost(req).catch(console.error);
      }

      await new Promise(r => setTimeout(r, 5000));
      jdLoopCount++;
    }

    updatePipelineState({ stepProgress: 'JD Extraction complete. Running local triage...' });
    const localQueuedCount = await prisma.job.count({ where: { scoringStatus: 'queued', jdBatchId: null, status: { in: ['pending_af', 'inbox'] } } });
    let totalLocalProcessed = 0;
    for (let localPass = 0; localPass < 20; localPass++) {
      const processed = await scoreJobs((msg) => {
        if (!msg.startsWith('No new jobs') && !msg.startsWith('No resumes')) totalLocalProcessed++;
        updatePipelineState({ stepProgress: `[Processed: ${totalLocalProcessed}/${localQueuedCount}] ${msg}` });
      });
      if (processed === 0) break;
    }

    // This standalone route intentionally sends its newly ingested broad-search
    // candidates straight to the wildcard evaluator. The full pipeline instead
    // runs standard scoring first and only sends its rejects to Wildcard.
    await prisma.job.updateMany({
      where: {
        createdAt: { gte: runStartedAt },
        status: 'pending_af',
        scoringStatus: 'scored',
        luckyStatus: 'pending',
      },
      data: {
        status: 'dismissed',
        passReason: '[Wildcard candidate] Awaiting wildcard evaluation.',
      },
    });

    updatePipelineState({ stepProgress: `Local triage complete. Evaluating wildcard candidates...` });

    let totalProcessed = 0;
    while (true) {
      const pendingCount = await prisma.job.count({
        where: {
          luckyStatus: 'pending',
          status: 'dismissed',
          jdBatchId: null,
          batchJobId: null,
          afBatchId: null,
        },
      });
      if (pendingCount === 0) break;
      
      updatePipelineState({ stepProgress: `[Processed: ${totalProcessed}] Wildcard Evaluation: ${pendingCount} jobs queued...` });
      
      const evalResult = await runLuckyEvaluation((msg) => {
        updatePipelineState({ stepProgress: `[Processed: ${totalProcessed}] Wildcard Evaluation: ${msg}` });
      });
      
      if (evalResult.scoresProcessed === 0 && evalResult.staleClaimsReleased === 0) {
        break;
      }
      totalProcessed += evalResult.scoresProcessed;
      await new Promise(r => setTimeout(r, 2000));
    }

    updatePipelineState({ isRunning: false, currentStep: 'Idle', stepProgress: `Lucky Evaluator processed ${totalProcessed} jobs.` });
  } catch (error: unknown) {
    console.error("Lucky Pipeline error:", error);
    updatePipelineState({ isRunning: false, currentStep: 'Error', stepProgress: `Error: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    releaseLock();
  }
}

export async function POST() {
  try {
    const releaseLock = tryAcquirePipelineLock();
    if (!releaseLock) {
       return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    try {
      updatePipelineState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing lucky pipeline' });
    } catch (error) {
      releaseLock();
      throw error;
    }

    processPipeline(releaseLock).catch(console.error);

    return NextResponse.json({ message: 'Lucky Pipeline started in background' });
  } catch (error: unknown) {
    return NextResponse.json({ error: 'Failed to start lucky pipeline', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
