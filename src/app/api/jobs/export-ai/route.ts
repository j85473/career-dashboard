import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAllResumes } from '@/lib/resume';

export async function GET() {
  try {
    // 1. Get Resume
    const resumes = await getAllResumes();
    const coreResume = resumes.find(r => r.name === 'Core') || resumes[0];
    if (!coreResume) {
      return NextResponse.json({ error: 'No resume found.' }, { status: 400 });
    }

    // 2. Get Context DB Rules
    const contextProfile = await prisma.contextProfile.findFirst();
    const rulesText = contextProfile?.rulesText || "No context rules found. Be lenient.";

    // 3. Get Context Updates (Jobs passed/applied that need context extraction)
    const contextUpdates = await prisma.job.findMany({
      where: {
        status: { in: ['passed', 'applied'] },
        contextBatched: false,
        description: { not: '' }
      },
      take: 20,
      select: {
        id: true,
        title: true,
        company: true,
        description: true,
      }
    });

    // 4. Get Jobs to Score (A/E Fit queue)
    const jobsToScore = await prisma.job.findMany({
      where: {
        status: 'pending_af',
        scoringStatus: 'scored',
        afBatchId: null,
      },
      take: 100,
      select: {
        id: true,
        title: true,
        company: true,
        description: true,
        location: true,
        url: true,
        manualAts: true,
      }
    });

    // Assemble payload
    const payload = {
      _AI_INSTRUCTIONS: "🛑 SYSTEM OVERRIDE: STRICT AI EVALUATION MODE 🛑\n\nCRITICAL INSTRUCTION: You are an AI assistant processing this A/E Fit scoring batch natively in this chat context. You MUST NOT write or execute any Python scripts or hard-coded heuristics to score these jobs. You MUST use your own advanced semantic reasoning capabilities as a Large Language Model to evaluate each job individually against the provided 'resume' and 'contextProfile'.\n\n1) Read 'contextUpdates' and update your internal understanding of the user's Context DB.\n2) Evaluate every single job in 'jobsToScore' based strictly on the nuances of the Context DB rules and the Resume. Do not take shortcuts.\n3) If a job's 'manualAts' is missing or unknown, carefully analyze its 'description' and 'url' to identify the likely ATS system (e.g., Workday, Greenhouse, Lever, etc.).\n4) Return a strictly formatted JSON object containing: { updatedContextRules: string, processedContextJobIds: string[], jobScores: [{ id: string, aimFitScore: number, aimFitReason: string, experienceFitScore: number, experienceFitReason: string, travelScore: number, atsSystem: string }] }.\n5) Output ONLY this JSON object inside a single markdown code block. Do NOT include any conversational filler.",
      resume: coreResume.text,
      contextProfile: {
        id: contextProfile?.id,
        rulesText: rulesText
      },
      contextUpdates,
      jobsToScore,
      timestamp: new Date().toISOString()
    };

    // Return as downloadable file
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="antigravity_evaluation_batch_${Date.now()}.json"`
      }
    });

  } catch (error: any) {
    console.error('Export AI Batch failed:', error);
    return NextResponse.json({ error: 'Failed to export batch', details: error.message }, { status: 500 });
  }
}
