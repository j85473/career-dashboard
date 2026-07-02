import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import os from 'os';
import path from 'path';

export async function GET(request: Request) {
  try {
    const contextProfile = await prisma.contextProfile.findFirst();
    if (!contextProfile || !contextProfile.batchJobId) {
      return NextResponse.json({ message: 'No Context batch currently processing.' });
    }

    const batchId = contextProfile.batchJobId;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey });
    const batchData = await ai.batches.get({ name: batchId });
      
    if (batchData.state === 'JOB_STATE_SUCCEEDED') {
      const fileName = batchData.dest?.fileName;
      
      if (fileName) {
        const tempPath = path.join(os.tmpdir(), `batch_context_output_${Date.now()}.jsonl`);
        await ai.files.download({ file: fileName, downloadPath: tempPath });
        
        const outputText = fs.readFileSync(tempPath, 'utf8');
        fs.unlinkSync(tempPath);

        const lines = outputText.split('\n').filter(l => l.trim() !== '');
        
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.response && data.response.candidates && data.response.candidates.length > 0) {
              const textOutput = data.response.candidates[0].content.parts[0].text;
              
              let rulesTextToSave = textOutput;
              const jsonMatch = textOutput.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                try {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (parsed.rulesText) rulesTextToSave = parsed.rulesText;
                } catch (e) {}
              }
              
              // Clear contextBatched flag on all processed jobs
              // Removed because batch-context already sets this to true upon submission,
              // and setting it here would incorrectly mark jobs reviewed while the batch was processing.

              // Update the profile rules
              await prisma.contextProfile.update({
                where: { id: contextProfile.id },
                data: {
                  rulesText: rulesTextToSave,
                  batchJobId: null
                }
              });
              
              return NextResponse.json({ message: 'Context Batch check complete. DB Updated.', processed: true });
            }
          } catch (e) {
            console.error('Failed to parse Context output line:', e);
          }
        }
      }
    } else if (batchData.state === 'JOB_STATE_FAILED' || batchData.state === 'JOB_STATE_CANCELLED') {
      await prisma.contextProfile.update({
        where: { id: contextProfile.id },
        data: { batchJobId: null }
      });
      
      // Reset contextBatched so they get picked up again
      await prisma.job.updateMany({
        where: { contextBatched: true },
        data: { contextBatched: false }
      });
      return NextResponse.json({ message: 'Context Batch failed or cancelled.', processed: false });
    }

    return NextResponse.json({ message: 'Batch is still processing...', processed: false });
  } catch (error: any) {
    console.error('Gemini Context Batch Status check failed:', error);
    return NextResponse.json({ error: 'Failed to check batch status', details: error.message }, { status: 500 });
  }
}
