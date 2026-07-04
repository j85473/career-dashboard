import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { PrismaClient } from '@prisma/client';
import { GoogleGenAI, Type } from '@google/genai';
import { getAllResumes } from '../src/lib/resume';

const prisma = new PrismaClient();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const oldSchema = {
  type: Type.OBJECT,
  properties: {
    aimFitScore: { type: Type.INTEGER, description: 'Score from 1 to 10 on how well the job matches the Context DB rules' },
    aimFitReason: { type: Type.STRING, description: 'A short, 1-2 sentence explanation for the Aim Fit score' },
    experienceFitScore: { type: Type.INTEGER, description: 'Score from 0 to 100 representing how well the candidate meets the core requirements' },
    experienceFitReason: { type: Type.STRING, description: 'A 2-3 sentence explanation of why they received this experience score' },
    travelScore: { type: Type.INTEGER, description: 'A score from 0 to 100 representing the amount of travel required. Default to 0 if not mentioned.' },
  },
  required: ['aimFitScore', 'aimFitReason', 'experienceFitScore', 'experienceFitReason', 'travelScore'],
};

// Travel is stripped from the LLM prompt in the new architecture because we use heuristics.
const newSchema = {
  type: Type.OBJECT,
  properties: {
    aimFitScore: { type: Type.INTEGER, description: 'Score from 1 to 10 on how well the job matches the Context DB rules' },
    aimFitReason: { type: Type.STRING, description: 'A short, 1-2 sentence explanation for the Aim Fit score' },
    experienceFitScore: { type: Type.INTEGER, description: 'Score from 0 to 100 representing how well the candidate meets the core requirements' },
    experienceFitReason: { type: Type.STRING, description: 'A 2-3 sentence explanation of why they received this experience score' },
  },
  required: ['aimFitScore', 'aimFitReason', 'experienceFitScore', 'experienceFitReason'],
};

// JD Minification logic 
function minifyJd(raw: string): string {
  if (!raw) return 'No description provided.';
  
  // Strip HTML and Jina boilerplate
  let text = raw
    .replace(/Original Truncated Snippet:[\s\S]*?Canonical Webpage Scraped Text:\s*/i, '')
    .replace(/^Title:\s.*$/m, '')
    .replace(/^URL Source:\s.*$/m, '')
    .replace(/^Markdown Content:\s*$/m, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ');

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ')
             .replace(/\n[ \t]*/g, '\n')
             .replace(/\n{3,}/g, '\n\n')
             .trim();

  // Cap at 5000 chars
  if (text.length <= 5000) return text;
  return `${text.slice(0, 3750)}\n[... trimmed ...]\n${text.slice(-1250)}`;
}

async function main() {
  const sampleSize = 20;

  const jobs = await prisma.job.findMany({
    where: { description: { not: null } },
    orderBy: { updatedAt: 'desc' },
    take: sampleSize,
    select: { id: true, title: true, company: true, location: true, description: true },
  });

  const contextProfile = await prisma.contextProfile.findFirst();
  const rulesText = contextProfile?.rulesText || '';
  const resumes = await getAllResumes();
  const coreResume = resumes.find(r => r.name === 'Core') || resumes[0];

  console.log(`Simulating Ultimate Hybrid Architecture on ${jobs.length} jobs...`);

  const usage = { oldIn: 0, oldOut: 0, newIn: 0, newOut: 0 };

  // 1. STEP ONE: Generate the Candidate Evaluation Matrix (One-time cost)
  console.log('Generating Candidate Evaluation Matrix...');
  const matrixPrompt = `You are an elite career strategist. I need to compress my full resume and career rules into a dense, highly optimized "Candidate Evaluation Matrix". 
This matrix will be injected into future prompts to evaluate job descriptions, replacing the need to send the full documents.

RULES FOR THE MATRIX:
1. It MUST be under 300 words. Be extremely terse. Use bullet points and abbreviations.
2. It MUST capture all hard dealbreakers and salary requirements.
3. It MUST capture core skills, years of experience in key technologies, and major achievements.
4. Do not include boilerplate. Just facts.

MY RESUME:
${coreResume.text}

MY CONTEXT DB RULES:
${rulesText}

Generate the matrix now.`;

  const matrixRes = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: matrixPrompt,
  });
  const evaluationMatrix = matrixRes.text;
  
  // Record the upfront token cost of generation
  usage.newIn += matrixRes.usageMetadata?.promptTokenCount || 0;
  usage.newOut += matrixRes.usageMetadata?.candidatesTokenCount || 0;
  
  console.log('=== CANDIDATE EVALUATION MATRIX ===');
  console.log(evaluationMatrix);
  console.log('===================================');

  // 2. Evaluate Jobs
  const oldResults = new Map<string, any>();
  const newResults = new Map<string, any>();

  console.log('\nScoring jobs (Old vs New)...');
  
  for (const job of jobs) {
    // --- OLD LOGIC ---
    const oldPrompt = `You are an expert technical recruiter and career strategist.
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
${rulesText}`;

    const oldRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: oldPrompt,
      config: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: oldSchema },
    });
    usage.oldIn += oldRes.usageMetadata?.promptTokenCount || 0;
    usage.oldOut += oldRes.usageMetadata?.candidatesTokenCount || 0;
    oldResults.set(job.id, JSON.parse(oldRes.text || '{}'));

    // --- NEW LOGIC (Ultimate Hybrid) ---
    const newPrompt = `You are an expert technical recruiter. Evaluate the provided Job Description against my Candidate Evaluation Matrix.

1. AIM FIT: Does this job align with the goals and dealbreakers in the Matrix?
2. EXPERIENCE FIT: Does my experience (from the Matrix) meet the core technical requirements of this role?

Job Title: ${job.title}
Company: ${job.company}

JOB DESCRIPTION:
${minifyJd(job.description || '')}

CANDIDATE EVALUATION MATRIX:
${evaluationMatrix}`;

    const newRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: newPrompt,
      config: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: newSchema },
    });
    usage.newIn += newRes.usageMetadata?.promptTokenCount || 0;
    usage.newOut += newRes.usageMetadata?.candidatesTokenCount || 0;
    newResults.set(job.id, JSON.parse(newRes.text || '{}'));
  }

  // 3. Compare Results
  let aimDeltaSum = 0, efDeltaSum = 0, agree = 0, compared = 0;
  console.log('\njobId(8)  | AIM old→new | EF old→new | decision');
  console.log('----------|-------------|------------|---------');
  
  for (const job of jobs) {
    const o = oldResults.get(job.id);
    const n = newResults.get(job.id);
    if (!o || !n) continue;
    compared++;
    const passOld = o.aimFitScore >= 7 && o.experienceFitScore >= 50;
    const passNew = n.aimFitScore >= 7 && n.experienceFitScore >= 50;
    if (passOld === passNew) agree++;
    aimDeltaSum += Math.abs(o.aimFitScore - n.aimFitScore);
    efDeltaSum += Math.abs(o.experienceFitScore - n.experienceFitScore);
    console.log(
      `${job.id.slice(0, 8)}  | ${String(o.aimFitScore).padStart(4)}→${String(n.aimFitScore).padEnd(4)} | ` +
      `${String(o.experienceFitScore).padStart(4)}→${String(n.experienceFitScore).padEnd(4)} | ` +
      `${passOld === passNew ? 'AGREE' : `DISAGREE (${passOld ? 'pass' : 'dismiss'}→${passNew ? 'pass' : 'dismiss'})`}`
    );
  }

  console.log('\n=== ULTIMATE HYBRID SUMMARY ===');
  console.log(`Compared: ${compared} jobs`);
  console.log(`Aim Fit MAE:        ${(aimDeltaSum / compared).toFixed(2)} (scale 1-10)`);
  console.log(`Experience Fit MAE: ${(efDeltaSum / compared).toFixed(2)} (scale 0-100)`);
  console.log(`Pass/dismiss agreement: ${agree}/${compared} (${((agree / compared) * 100).toFixed(1)}%)`);
  console.log(`Input tokens:  OLD ${usage.oldIn} → NEW ${usage.newIn} (${(100 * (1 - usage.newIn / usage.oldIn)).toFixed(1)}% reduction)`);
  console.log(`Output tokens: OLD ${usage.oldOut} → NEW ${usage.newOut} (${(100 * (1 - usage.newOut / usage.oldOut)).toFixed(1)}% reduction)`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
