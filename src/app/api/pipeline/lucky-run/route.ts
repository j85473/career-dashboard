import { NextResponse } from "next/server";
import { ingestJobs } from "@/lib/jobIngestion";
import { runLuckyEvaluation } from "@/lib/luckyEvaluator";
import { prisma } from "@/lib/prisma";
import fs from 'fs';
import path from 'path';
import { POST as jdSubmitPost } from '../../jobs/batch-jd-submit/route';

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const STATE_FILE = path.join(process.cwd(), '.pipeline_state.json');

function updateState(state: any) {
  try {
    let current = {};
    if (fs.existsSync(STATE_FILE)) {
      current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...state, lastUpdated: Date.now() }));
  } catch (e) {
    console.error('Failed to update pipeline state', e);
  }
}

async function processPipeline() {
  try {
    updateState({ isRunning: true, currentStep: "I'm Feeling Lucky", stepProgress: "Starting I'm Feeling Lucky Pipeline..." });

    if (!DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY is not set');
    }

    const wildcardProfile = await prisma.wildcardProfile.findFirst();
    const profileText = wildcardProfile?.profileText || "A highly autonomous builder and generalist.";

    // Fetch previously used queries to avoid repetition
    const usedQueriesRecords = await prisma.usedWildcardQuery.findMany({ select: { query: true } });
    const usedQueries = usedQueriesRecords.map(r => r.query);
    const usedQueriesContext = usedQueries.length > 0 
      ? `\n\nCRITICAL: Do NOT output any of these previously used queries: ${usedQueries.join(', ')}`
      : '';

    updateState({ stepProgress: "Generating dynamic search queries via DeepSeek..." });

    // Call DeepSeek to get search queries
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: `You are a creative job recruiter. Output a JSON object with { queries: string[] } containing exactly 3 broad, single-word (or very short 2-word) search concepts that would cast a wide net for this Wildcard Profile. Examples: 'operations', 'strategy', 'growth', 'innovation', 'ventures'.${usedQueriesContext}` },
          { role: "user", content: `Wildcard Profile:\n${profileText}` }
        ],
        temperature: 0.9,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const responseData = await response.json();
    const textContent = responseData.choices?.[0]?.message?.content || '';
    const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = match ? match[1].trim() : textContent.trim();
    
    let queries: string[] = ["strategy", "operations", "growth"];
    try {
      const parsedObj = JSON.parse(jsonStr);
      if (Array.isArray(parsedObj.queries) && parsedObj.queries.length > 0) {
        queries = parsedObj.queries.slice(0, 3);
      }
    } catch(e) {
      console.error('Failed to parse search queries, using defaults.', e);
    }

    updateState({ stepProgress: `Generated Queries: ${queries.join(', ')}` });

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
      updateState({ stepProgress: `Running ingestion for query: "${query}"...` });
      const numIngested = await ingestJobs((msg) => {
        updateState({ stepProgress: msg });
      }, undefined, undefined, query, 'pending_af', true);
      totalIngested += numIngested;
    }

    updateState({ stepProgress: `Ingested ${totalIngested} new wildcard jobs. Extracting JDs...` });

    // 2. Loop JD Extraction
    let jdLoopCount = 0;
    while (true) {
      const needsJdCount = await prisma.job.count({ 
        where: { scoringStatus: 'needs_jd', jdBatchId: null, status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] }, scoreAttempts: { lt: 3 } } 
      });
      const processingJdCount = await prisma.job.count({
        where: { scoringStatus: 'needs_jd', jdBatchId: { not: null }, status: { notIn: ['passed', 'dismissed', 'applied', 'archived'] } }
      });

      if (needsJdCount === 0 && processingJdCount === 0) {
        break; // Done with JD Extraction
      }
      if (jdLoopCount > 60) {
        console.warn('JD Extraction loop timed out after 5 minutes.');
        break; // Prevent infinite loop if jobs get stuck in processing
      }

      updateState({ stepProgress: `JD Extraction: ${needsJdCount} queued, ${processingJdCount} processing...` });

      if (needsJdCount > 0) {
        const req = new Request('https://internal-pipeline/api/jobs/batch-jd-submit', { method: 'POST' });
        await jdSubmitPost(req).catch(console.error);
      }

      await new Promise(r => setTimeout(r, 5000));
      jdLoopCount++;
    }

    updateState({ stepProgress: `JD Extraction complete. Evaluating...` });

    let wildcardComplete = false;
    let totalProcessed = 0;
    while (!wildcardComplete) {
      const pendingCount = await prisma.job.count({ where: { luckyStatus: 'pending' } });
      if (pendingCount === 0) break;
      
      updateState({ stepProgress: `Wildcard Evaluation: ${pendingCount} jobs queued...` });
      
      const evalResult = await runLuckyEvaluation((msg) => {
        updateState({ stepProgress: `Wildcard Evaluation: ${msg}` });
      });
      
      if (evalResult.scoresProcessed === 0) {
        break;
      }
      totalProcessed += evalResult.scoresProcessed;
      await new Promise(r => setTimeout(r, 2000));
    }

    updateState({ isRunning: false, currentStep: 'Idle', stepProgress: `Lucky Evaluator processed ${totalProcessed} jobs.` });
  } catch (error: any) {
    console.error("Lucky Pipeline error:", error);
    updateState({ isRunning: false, currentStep: 'Error', stepProgress: `Error: ${error.message}` });
  }
}

export async function GET() {
  try {
    let current: any = { isRunning: false };
    if (fs.existsSync(STATE_FILE)) {
      current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    
    if (current.isRunning && (Date.now() - (current.lastUpdated || 0)) < 1000 * 60 * 30) {
       return NextResponse.json({ message: 'Pipeline already running' }, { status: 400 });
    }

    updateState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing lucky pipeline' });
    
    processPipeline().catch(console.error);

    return NextResponse.json({ message: 'Lucky Pipeline started in background' });
  } catch (e: any) {
    return NextResponse.json({ error: 'Failed to start lucky pipeline', details: e.message }, { status: 500 });
  }
}
