import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

function localMinifier(text: string): string {
  const lines = text.split('\n');
  let isCapturing = false;
  const capturedLines: string[] = [];

  const startKeywords = ['responsibilities', 'what you will do', "what you'll do", 'requirements', 'qualifications', 'what you need', 'what you bring', 'experience'];
  const stopKeywords = ['about us', 'why join us', 'benefits', 'eeo', 'equal opportunity', 'diversity', 'company overview', 'who we are'];

  for (const line of lines) {
    const lowerLine = line.toLowerCase().trim();
    
    // Check for stop keywords first
    if (stopKeywords.some(kw => lowerLine === kw || lowerLine === kw + ':' || lowerLine === '## ' + kw)) {
      isCapturing = false;
      continue;
    }

    // Check for start keywords
    if (startKeywords.some(kw => lowerLine === kw || lowerLine === kw + ':' || lowerLine === '## ' + kw)) {
      isCapturing = true;
    }

    if (isCapturing) {
      capturedLines.push(line);
    }
  }

  if (capturedLines.length === 0) {
    return "LOCAL MINIFIER FAILED: Could not find standard headers.";
  }

  return capturedLines.join('\n');
}

async function main() {
  const jobId = '82b9b2ae-35b0-48f2-82d5-f72089cf11da'; // Cardinal Health job
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  
  if (!job || !job.description) {
    console.error('Job or description not found');
    return;
  }

  console.log("=========================================");
  console.log("ORIGINAL LENGTH:", job.description.length, "characters");
  console.log("=========================================\n");

  console.log("=== LOCAL HEURISTIC MINIFIER OUTPUT ===");
  const localOutput = localMinifier(job.description);
  console.log("Length:", localOutput.length, "characters");
  console.log(localOutput.substring(0, 500) + '...\\n');
}

main().finally(() => prisma.$disconnect());
