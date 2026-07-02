import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import os from 'os';
import path from 'path';

export async function GET(request: Request) {
  try {
    const processingJobs = await prisma.job.findMany({
      where: { 
        scoringStatus: 'needs_jd',
        jdBatchId: { notIn: ['processing'] },
        NOT: [
          { jdBatchId: null },
          { jdBatchId: { startsWith: 'run-' } }
        ]
      },
      select: { id: true, jdBatchId: true }
    });

    // Also check for jobs that were processed synchronously or fell back
    const synchronousCount = await prisma.job.count({
      where: { 
        jdBatchId: { startsWith: 'run-' }
      }
    });

    if (processingJobs.length === 0) {
      return NextResponse.json({ 
        message: 'No JD batches currently processing on Gemini API.',
        pendingCount: synchronousCount
      });
    }

    const batchJobIds = Array.from(new Set(processingJobs.map(j => j.jdBatchId).filter(id => id && !id.startsWith('run-'))));
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey });
    let processedCount = 0;

    for (const batchId of batchJobIds) {
      if (!batchId) continue;

      try {
        const batchData = await ai.batches.get({ name: batchId });
        
        if (batchData.state === 'JOB_STATE_SUCCEEDED') {
          const fileName = batchData.dest?.fileName;
          
          if (fileName) {
            const tempPath = path.join(os.tmpdir(), `batch_jd_output_${Date.now()}.jsonl`);
            await ai.files.download({ file: fileName, downloadPath: tempPath });
            
            const outputText = fs.readFileSync(tempPath, 'utf8');
            fs.unlinkSync(tempPath);

            const lines = outputText.split('\n').filter(l => l.trim() !== '');
            
            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                const jobId = data.key || data.id || data.request?.id; 
                
                if (data.response && data.response.candidates && data.response.candidates.length > 0) {
                  const textOutput = data.response.candidates[0].content.parts[0].text;
                  const jsonMatch = textOutput.match(/\{[\s\S]*\}/);
                  
                  if (jsonMatch && jobId) {
                    try {
                      const scoreData = JSON.parse(jsonMatch[0]);
                      
                      if (scoreData.description && scoreData.description.length > 300) {
                        await prisma.job.update({
                          where: { id: jobId },
                          data: {
                            description: scoreData.description.trim(),
                            scoringStatus: 'queued', 
                            scoreAttempts: 0,
                            experienceStatus: 'queued',
                            jdBatchId: null
                          }
                        });
                        processedCount++;
                      } else {
                         // Bad extraction
                         await prisma.job.update({
                           where: { id: jobId },
                           data: { jdBatchId: null, scoreAttempts: { increment: 1 } }
                         });
                      }
                    } catch (err) {
                      console.error(`Failed to parse AI score JSON for job ${jobId}`, err);
                    }
                  }
                }
              } catch (e) {
                console.error('Failed to parse JD output line:', e);
              }
            }
            
            // Safety net: Clear jdBatchId for any jobs that were missed or failed parsing
            await prisma.job.updateMany({
              where: { jdBatchId: batchId },
              data: { jdBatchId: null, scoreAttempts: { increment: 1 } }
            });
          }
        } else if (batchData.state === 'JOB_STATE_FAILED' || batchData.state === 'JOB_STATE_CANCELLED') {
          await prisma.job.updateMany({
            where: { jdBatchId: batchId },
            data: { jdBatchId: null, scoreAttempts: { increment: 1 } }
          });
        }
      } catch (err) {
        console.error(`Failed to process JD batch ${batchId}:`, err);
      }
    }

    return NextResponse.json({ message: 'JD Status check complete', processedCount, pendingCount: synchronousCount });
  } catch (error: any) {
    console.error('Gemini JD Batch Status check failed:', error);
    return NextResponse.json({ error: 'Failed to check JD batch status', details: error.message }, { status: 500 });
  }
}
