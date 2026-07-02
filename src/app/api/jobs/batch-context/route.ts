import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function POST(request: Request) {
  try {
    // 1. Get all jobs manually reviewed that haven't been batched yet
    const reviewedJobs = await prisma.job.findMany({
      where: {
        status: { in: ['passed', 'applied'] },
        contextBatched: false,
      }
    });

    if (reviewedJobs.length === 0) {
      return NextResponse.json({ message: 'No new manual reviews to batch.' });
    }

    // 2. Fetch the current Context Profile
    let contextProfile = await prisma.contextProfile.findFirst();
    if (!contextProfile) {
      contextProfile = await prisma.contextProfile.create({
        data: {
          id: 'global',
          rulesText: 'No rules learned yet.'
        }
      });
    }

    // 3. Construct the prompt
    let jobHistoryText = reviewedJobs.map(j => `Title: ${j.title}\nCompany: ${j.company}\nAction: ${j.status.toUpperCase()}\nRationale: ${j.fitRationale || 'None'}`).join('\n\n');

    const prompt = `Act as an expert Career AI. I am updating my Context Profile (my Master Rulebook) based on recent manual reviews.

CURRENT RULEBOOK:
${contextProfile.rulesText}

RECENT REVIEWS TO LEARN FROM:
${jobHistoryText}

Analyze these new reviews. 
- If the user marked jobs as 'PASSED' (which means they rejected them), figure out WHY and add/update negative rules.
- If the user marked jobs as 'APPLIED', figure out what they like and add/update positive rules.

Return a JSON object containing a SINGLE string field 'rulesText'. This string should be a comprehensive, well-formatted markdown document outlining the entire rulebook (combining old rules with new learnings).

{
  "rulesText": "The complete markdown rulebook..."
}`;

    // 4. Submit as a 1-item batch job to Gemini Batch API
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey });

    const requestBody = {
      key: `context-update-${Date.now()}`,
      request: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        }
      }
    };

    const jsonl = JSON.stringify(requestBody) + '\n';
    const tempFilePath = path.join(os.tmpdir(), `context_batch_${Date.now()}.jsonl`);
    fs.writeFileSync(tempFilePath, jsonl);

    const file = await ai.files.upload({
      file: tempFilePath,
      config: { mimeType: 'text/plain' }
    });
    fs.unlinkSync(tempFilePath);

    const batchJob = await ai.batches.create({
      model: 'gemini-2.5-flash',
      src: file.name!
    });

    const batchName = batchJob.name;

    await prisma.contextProfile.update({
      where: { id: contextProfile.id },
      data: { batchJobId: batchName }
    });
    
    // We can just add batchId tracking to ContextProfile in schema later, or rely on gemini-batch-status API.
    // For now, let's just mark jobs as contextBatched: true
    await prisma.job.updateMany({
      where: { id: { in: reviewedJobs.map(j => j.id) } },
      data: { contextBatched: true }
    });

    return NextResponse.json({ message: 'Context Batch submitted', batchJobId: batchName, jobsIncluded: reviewedJobs.length });
  } catch (error: any) {
    console.error('Context Batch Submit failed:', error);
    return NextResponse.json({ error: 'Failed to submit batch', details: error.message }, { status: 500 });
  }
}
