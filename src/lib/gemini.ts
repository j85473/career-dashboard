import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { prisma } from './prisma';

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const DAILY_TOKEN_LIMIT = 1000000000; // Increased to 1 Billion tokens since your new key has massive 4M TPM limits

export async function checkTokenLimit() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const usage = await prisma.usageTracking.findUnique({ where: { date: today } });
  
  if (usage && usage.tokens >= DAILY_TOKEN_LIMIT) {
    throw new Error('Daily Gemini token limit reached to prevent cost overruns.');
  }
}

export async function trackUsage(promptTokenCount: number, candidatesTokenCount: number) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const totalTokens = promptTokenCount + candidatesTokenCount;
  
  const costIncrement = (promptTokenCount * 0.10 / 1000000) + (candidatesTokenCount * 0.40 / 1000000);

  try {
    await prisma.usageTracking.upsert({
      where: { date: today },
      update: { 
        tokens: { increment: totalTokens },
        inputTokens: { increment: promptTokenCount },
        outputTokens: { increment: candidatesTokenCount },
        cost: { increment: costIncrement }
      },
      create: { 
        date: today, 
        tokens: totalTokens,
        inputTokens: promptTokenCount,
        outputTokens: candidatesTokenCount,
        cost: costIncrement
      },
    });
  } catch (e: any) {
    // If multiple workers hit the exact same millisecond on a new day, upsert can throw a unique constraint error.
    if (e.code === 'P2002') {
      await prisma.usageTracking.update({
        where: { date: today },
        data: { 
          tokens: { increment: totalTokens },
          inputTokens: { increment: promptTokenCount },
          outputTokens: { increment: candidatesTokenCount },
          cost: { increment: costIncrement }
        }
      }).catch(() => {});
    }
  }
}

export async function callGemini(prompt: string, systemInstruction?: string, retries = 3, modelId = 'gemini-2.5-flash', useSearch = false) {
  await checkTokenLimit();
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await genai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.1,
          responseMimeType: useSearch ? undefined : 'application/json',
          tools: useSearch ? [{ googleSearch: {} }] : undefined,
          safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
          ]
        }
      });

      if (response.usageMetadata) {
        await trackUsage(
          response.usageMetadata.promptTokenCount || 0,
          response.usageMetadata.candidatesTokenCount || 0
        );
      }

      return response.text;
    } catch (error: any) {
      if (error.status === 503 && i < retries - 1) {
        console.warn(`Gemini 503 Error (High Demand). Retrying in ${2000 * (i + 1)}ms...`);
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      } else {
        throw error;
      }
    }
  }
}
