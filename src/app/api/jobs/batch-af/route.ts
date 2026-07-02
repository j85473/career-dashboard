import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GoogleGenAI, Type } from '@google/genai';
import { getAllResumes } from '@/lib/resume';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function POST(request: Request) {
  try {
    const queuedJobs = await prisma.job.findMany({
      where: { 
        status: 'pending_af',
        scoringStatus: 'scored',
        afBatchId: null
      },
      take: 50 // limit for batch processing
    });

    if (queuedJobs.length === 0) {
      return NextResponse.json({ message: 'No jobs queued for combined batch submission.' });
    }

    // Atomic claim
    const claimResult = await prisma.job.updateMany({
      where: {
        id: { in: queuedJobs.map(j => j.id) },
        afBatchId: null
      },
      data: { afBatchId: 'processing' }
    });

    if (claimResult.count === 0) {
      return NextResponse.json({ message: 'Jobs already claimed.' });
    }

    const contextProfile = await prisma.contextProfile.findFirst();
    const rulesText = contextProfile?.rulesText || "No context rules found. Be lenient.";

    const resumes = await getAllResumes();
    const coreResume = resumes.find(r => r.name === 'Core') || resumes[0];
    if (!coreResume) {
      return NextResponse.json({ error: 'No resume found.' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey });

    // 1. Build JSONL
    let jsonl = '';
    for (const job of queuedJobs) {
      const prompt = `You are an expert technical recruiter and career strategist.
Evaluate the provided Job Description against my Resume and my Context DB Rules.

1. AIM FIT: Does this job align with my career goals, salary requirements, and dealbreakers (from Context DB Rules)?
2. EXPERIENCE FIT: Does my ACTUAL past experience and skills meet the core requirements of this role (from Resume)? Ignore ATS keywords; focus on years of experience, specific tools, domain knowledge, and responsibilities.
3. TRAVEL: Identify how much travel is required for the position.

Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'Unknown'}

JOB DESCRIPTION:
${job.description || 'No description provided.'}

CANDIDATE RESUME:
${coreResume.text}

CONTEXT DB RULES:
${rulesText}
`;

      const requestBody = {
        key: job.id, // Map back using job.id
        request: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                aimFitScore: { 
                  type: Type.INTEGER, 
                  description: "Score from 1 to 10 on how well the job matches the Context DB rules" 
                },
                aimFitReason: { 
                  type: Type.STRING, 
                  description: "A short, 1-2 sentence explanation for the Aim Fit score" 
                },
                experienceFitScore: { 
                  type: Type.INTEGER, 
                  description: "Score from 0 to 100 representing how well the candidate meets the core requirements" 
                },
                experienceFitReason: { 
                  type: Type.STRING, 
                  description: "A 2-3 sentence explanation of why they received this experience score" 
                },
                travelScore: {
                  type: Type.INTEGER,
                  description: "A score from 0 to 100 representing the amount of travel required (0 = no travel, 25 = 25% travel, 100 = 100% constant travel). Default to 0 if not mentioned."
                }
              },
              required: [
                "aimFitScore", 
                "aimFitReason", 
                "experienceFitScore", 
                "experienceFitReason",
                "travelScore"
              ],
            }
          }
        }
      };
      
      jsonl += JSON.stringify(requestBody) + '\n';
    }

    // 2. Upload file to Gemini using @google/genai SDK
    const tempFilePath = path.join(os.tmpdir(), `batch_combined_${Date.now()}.jsonl`);
    fs.writeFileSync(tempFilePath, jsonl);

    const file = await ai.files.upload({
      file: tempFilePath,
      config: { mimeType: 'text/plain' }
    });

    fs.unlinkSync(tempFilePath);

    // 3. Create Batch Job
    const batchJob = await ai.batches.create({
      model: 'gemini-2.5-flash',
      src: file.name!
    });

    const batchName = batchJob.name;

    // 4. Update DB
    await prisma.job.updateMany({
      where: { 
        id: { in: queuedJobs.map(j => j.id) }
      },
      data: { afBatchId: batchName } 
    });

    return NextResponse.json({ message: 'Combined Batch submitted successfully', batchJobId: batchName, count: queuedJobs.length });
  } catch (error: any) {
    console.error('Combined Batch Submit failed:', error);
    return NextResponse.json({ error: 'Failed to submit batch', details: error.message }, { status: 500 });
  }
}
