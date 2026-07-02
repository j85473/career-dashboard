import { PrismaClient } from '@prisma/client';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import 'dotenv/config';

const prisma = new PrismaClient();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function main() {
  try {
    const tempFilePath = path.join(os.tmpdir(), `batch_jd_${Date.now()}.jsonl`);
    const jsonl = '{"request": {"model": "gemini-1.5-flash-8b"}}\n';
    fs.writeFileSync(tempFilePath, jsonl);

    const file = await ai.files.upload({
      file: tempFilePath,
      config: { mimeType: 'text/plain' }
    });
    console.log('Upload successful', file.name);

    fs.unlinkSync(tempFilePath);
  } catch (err: any) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}
main();
