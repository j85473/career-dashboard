import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const contextProfile = await prisma.contextProfile.findFirst();
    
    // Automatically harvest LinkedIn Batch if it exists
    if (contextProfile && contextProfile.linkedinBatchId) {
      const { GoogleGenAI } = await import('@google/genai');
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        const ai = new GoogleGenAI({ apiKey });
        const batchData = await ai.batches.get({ name: contextProfile.linkedinBatchId });
        
        if (batchData.state === 'JOB_STATE_SUCCEEDED') {
          const fileName = batchData.dest?.fileName;
          if (fileName) {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            
            const tempPath = path.join(os.tmpdir(), `batch_li_output_${Date.now()}.jsonl`);
            await ai.files.download({ file: fileName, downloadPath: tempPath });
            const outputText = fs.readFileSync(tempPath, 'utf8');
            fs.unlinkSync(tempPath);

            const lines = outputText.split('\n').filter(l => l.trim() !== '');
            for (const line of lines) {
              const data = JSON.parse(line);
              if (data.response?.candidates?.length > 0) {
                const textOutput = data.response.candidates[0].content.parts[0].text;
                const jsonMatch = textOutput.match(/\[[\s\S]*?\]/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  await prisma.linkedInDraft.deleteMany({});
                  for (const option of parsed) {
                    await prisma.linkedInDraft.create({
                      data: {
                        title: option.title,
                        postText: option.postText,
                        url: option.url
                      }
                    });
                  }
                }
              }
            }
          }
          await prisma.contextProfile.update({
            where: { id: contextProfile.id },
            data: { linkedinBatchId: null }
          });
          return NextResponse.json({ message: 'LinkedIn batch processed successfully' });
        } else if (batchData.state === 'JOB_STATE_FAILED' || batchData.state === 'JOB_STATE_CANCELLED') {
          await prisma.contextProfile.update({
            where: { id: contextProfile.id },
            data: { linkedinBatchId: null }
          });
          return NextResponse.json({ message: 'LinkedIn batch failed or was cancelled' });
        }
      }
    }

    return NextResponse.json({ message: 'No batch to process or batch is still running' });
  } catch (error: unknown) {
    console.error('Failed to get or process LinkedIn drafts:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
