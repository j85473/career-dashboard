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
        status: 'pending_af',
        afBatchId: { not: null }
      },
      select: { id: true, afBatchId: true }
    });

    if (processingJobs.length === 0) {
      return NextResponse.json({ message: 'No Combined batches currently processing.' });
    }

    const batchJobIds = Array.from(new Set(processingJobs.map(j => j.afBatchId).filter(Boolean)));
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
            const tempPath = path.join(os.tmpdir(), `batch_combined_output_${Date.now()}.jsonl`);
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
                      
                      const aimFitScore = scoreData.aimFitScore || 0;
                      const aimFitReason = scoreData.aimFitReason || '';
                      const experienceFitScore = scoreData.experienceFitScore || 0;
                      const experienceFitReason = scoreData.experienceFitReason || '';
                      const travelScore = scoreData.travelScore || 0;
                      
                      // Logic to pass: Aim >= 7/10 AND Experience >= 50/100
                      const passes = aimFitScore >= 7 && experienceFitScore >= 50;
                      
                      // Fetch current status to avoid reverting a manual user action
                      const currentJob = await prisma.job.findUnique({
                        where: { id: jobId },
                        select: { status: true }
                      });
                      
                      if (currentJob) {
                        const shouldUpdateStatus = currentJob.status === 'pending_af';
                        
                        if (passes) {
                          // Promoted to Inbox for manual review
                          await prisma.job.update({
                            where: { id: jobId },
                            data: {
                              ...(shouldUpdateStatus ? { status: 'inbox' } : {}),
                              aimFitScore: aimFitScore,
                              passReason: aimFitReason, // Store aim fit reason here
                              reqFitScore: experienceFitScore,
                              reqFitRationale: experienceFitReason,
                              travelScore: travelScore,
                              afBatchId: null,
                              scoringStatus: 'scored',
                              experienceStatus: 'scored'
                            }
                          });
                        } else {
                          // Dismissed
                          await prisma.job.update({
                            where: { id: jobId },
                            data: {
                              ...(shouldUpdateStatus ? { status: 'dismissed' } : {}),
                              fitCategory: 'rejected',
                              aimFitScore: aimFitScore,
                              passReason: aimFitReason,
                              reqFitScore: experienceFitScore,
                              reqFitRationale: experienceFitReason,
                              travelScore: travelScore,
                              afBatchId: null,
                              scoringStatus: 'scored',
                              experienceStatus: 'scored'
                            }
                          });
                        }
                      }
                      processedCount++;
                    } catch (err) {
                      console.error(`Failed to parse AI score JSON for job ${jobId}`, err);
                      // Handle parse failure explicitly
                      await prisma.job.update({
                        where: { id: jobId },
                        data: { passReason: 'Failed to parse AI JSON', afBatchId: null, scoreAttempts: { increment: 1 } }
                      });
                    }
                  } else if (jobId) {
                      // Failed to extract JSON block from text output
                      await prisma.job.update({
                        where: { id: jobId },
                        data: { passReason: 'Failed to extract JSON from AI response', afBatchId: null, scoreAttempts: { increment: 1 } }
                      });
                  }
                }
              } catch (e) {
                console.error('Failed to parse AF output line:', e);
              }
            }
            
            // Catch any jobs in this batch that failed parsing or were missing in the output
            // This is a safety net so jobs don't get permanently stuck in pending_af
            await prisma.job.updateMany({
              where: { afBatchId: batchId },
              data: { status: 'pending_af', afBatchId: null }
            });
            
          }
        } else if (batchData.state === 'JOB_STATE_FAILED' || batchData.state === 'JOB_STATE_CANCELLED') {
          await prisma.job.updateMany({
            where: { afBatchId: batchId },
            data: { afBatchId: null } // reset it
          });
        }
      } catch (err) {
        console.error(`Failed to process batch ${batchId}:`, err);
      }
    }

    return NextResponse.json({ message: 'Status check complete', processedCount });
  } catch (error: any) {
    console.error('Gemini Combined Batch Status check failed:', error);
    return NextResponse.json({ error: 'Failed to check batch status', details: error.message }, { status: 500 });
  }
}
