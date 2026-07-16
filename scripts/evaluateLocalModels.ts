import { prisma } from '../src/lib/prisma';
import { getAllResumes } from '../src/lib/resume';

const MODELS = ['qwen2.5:14b'];
const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';

function extractJson(text: string) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end >= start) {
      return JSON.parse(text.substring(start, end + 1));
    }
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

import * as http from 'http';

async function queryOllama(model: string, prompt: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const instructedPrompt = prompt + `\n\nYou MUST return your answer as a valid JSON object with the following exact keys: "aimFitScore" (integer 1-10), "aimFitReason" (string), "experienceFitScore" (integer 0-100), "experienceFitReason" (string), "travelScore" (integer 0-100). Do NOT wrap in markdown \`\`\`json blocks. Return ONLY the JSON object.`;
    
    const req = http.request(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 900000 // 15 minutes
    }, (res) => {
      let fullResponse = "";
      res.on('data', (chunk) => {
        const text = chunk.toString();
        const lines = text.trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.response) fullResponse += parsed.response;
          } catch(e) {}
        }
      });
      res.on('end', () => {
        resolve(extractJson(fullResponse));
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout after 15 minutes'));
    });

    req.write(JSON.stringify({
      model,
      prompt: instructedPrompt,
      stream: true,
    }));
    req.end();
  });
}

async function main() {
  console.log("Starting Local Model Evaluation...");
  const jobs = await prisma.job.findMany({
    where: { 
      description: { not: '' },
      aimFitScore: { not: null },
      reqFitScore: { not: null }
    },
    take: 20
  });

  if (jobs.length === 0) {
    console.error("No jobs found with existing Gemini scores");
    return;
  }

  const contextProfile = await prisma.contextProfile.findFirst();
  const rulesText = contextProfile?.rulesText || "No context rules found. Be lenient.";
  const resumes = await getAllResumes();
  const coreResume = resumes.find((r: any) => r.name === 'Core') || resumes[0];

  const results: Record<string, { aimDiff: number[], expDiff: number[], agreeCount: number, errors: number }> = {};
  for (const model of MODELS) {
    results[model] = { aimDiff: [], expDiff: [], agreeCount: 0, errors: 0 };
  }

  // Pre-compute prompts to avoid doing it in the loop repeatedly
  const jobsWithPrompts = jobs.map(job => {
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
    return { job, prompt };
  });

  // Loop over MODELS first to prevent Ollama from thrashing memory
  for (const model of MODELS) {
    console.log(`\n========================================`);
    console.log(`Evaluating Model: ${model}`);
    console.log(`========================================`);
    
    let i = 1;
    for (const { job, prompt } of jobsWithPrompts) {
      console.log(`[${model}] Job ${i}/${jobs.length}: ${job.company} - ${job.title}`);
      i++;

      const geminiAim = Number(job.aimFitScore);
      const geminiExp = Number(job.reqFitScore);
      const geminiPass = geminiAim >= 7 && geminiExp >= 50;

      try {
        const localRes = await queryOllama(model, prompt);
        if (!localRes) {
          console.error(`  -> Failed to extract JSON from response.`);
          results[model].errors++;
          continue;
        }
        
        const localAim = Number(localRes.aimFitScore);
        const localExp = Number(localRes.experienceFitScore);
        
        if (localRes.aimFitScore == null || localRes.experienceFitScore == null || isNaN(localAim) || isNaN(localExp)) {
          console.error(`  -> Parsed JSON missing required number fields.`);
          results[model].errors++;
          continue;
        }
        
        const localPass = localAim >= 7 && localExp >= 50;
        
        results[model].aimDiff.push(Math.abs(geminiAim - localAim));
        results[model].expDiff.push(Math.abs(geminiExp - localExp));
        if (geminiPass === localPass) {
          results[model].agreeCount++;
        }

        console.log(`  -> Gemini [Aim: ${geminiAim}, Exp: ${geminiExp}, Pass: ${geminiPass}]`);
        console.log(`  -> Local  [Aim: ${localAim}, Exp: ${localExp}, Pass: ${localPass}]`);
      } catch (e: any) {
        console.error(`  -> Error:`, e.message, e.cause || '');
        results[model].errors++;
      }
    }
  }

  console.log("\n====== EVALUATION RESULTS ======");
  
  for (const model of MODELS) {
    const res = results[model];
    const n = res.aimDiff.length;
    if (n === 0) {
      console.log(`\nModel: ${model}\n  Failed all jobs.`);
      continue;
    }
    const aimMae = res.aimDiff.reduce((a, b) => a + b, 0) / n;
    const expMae = res.expDiff.reduce((a, b) => a + b, 0) / n;
    const agreeRate = (res.agreeCount / n) * 100;
    
    console.log(`\nModel: ${model}`);
    console.log(`  Aim Fit MAE: ${aimMae.toFixed(2)}`);
    console.log(`  Experience Fit MAE: ${expMae.toFixed(2)}`);
    console.log(`  Pass/Dismiss Agreement: ${agreeRate.toFixed(2)}%`);
    console.log(`  Errors/Invalid Output: ${res.errors}`);
  }
}

main().catch(console.error);
