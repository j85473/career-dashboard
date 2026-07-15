import { prisma } from './src/lib/prisma';
import { getAllResumes } from './src/lib/resume';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

async function runTest() {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not set in the environment variables.');
  }

  const resumes = await getAllResumes();
  const coreResume = resumes[0];

  const contextProfile = await prisma.contextProfile.findFirst();
  const rulesText = contextProfile?.rulesText || "No context rules found. Be lenient.";

  // Fetch 5 jobs that ALREADY have an aimFitScore so we can compare
  const jobsToScore = await prisma.job.findMany({
    where: {
      aimFitScore: { not: null },
      reqFitScore: { not: null },
      description: { not: '' }
    },
    take: 5,
    orderBy: { aimFitScore: 'desc' }, // Take high scoring jobs to see if they get penalized
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      location: true,
      url: true,
      manualAts: true,
      status: true,
      source: true,
      aimFitScore: true,
      reqFitScore: true,
    }
  });

  if (jobsToScore.length === 0) {
    console.log("No already-scored jobs found.");
    return;
  }

  const payload = {
    _AI_INSTRUCTIONS: `🛑 SYSTEM OVERRIDE: STRICT AI EVALUATION RUNTIME 🛑

CRITICAL INSTRUCTION: You are an AI assistant processing an A/E Fit scoring batch. You MUST execute this exact step-by-step runtime.

STEP 1: CONTEXT MAINTENANCE
Read 'contextUpdates'. If you discover a NEW preference, rewrite the 'updatedContextRules' to be a concise bulleted list of rules. DO NOT include conversational text, logs, or "Processed job XYZ" statements. ONLY return the final, clean bulleted list of constraints and preferences. If no changes are needed, return the exact original rules.

STEP 2: CHAIN-OF-THOUGHT EXPERIENCE EXTRACTION
For every job in 'jobsToScore', you MUST extract the following variables BEFORE scoring:
- required_domain: What specific industry/vertical does the job demand (e.g. Cybersecurity, Manufacturing)?
- candidate_domain: Does the candidate's resume match this industry?
- domain_match: Boolean (true/false) based strictly on domain alignment.
- required_years_in_domain: How many years are required?
- candidate_years_in_domain: How many years does the candidate have in this *specific* domain?

STEP 3: SCORING GUARDRAILS
- If domain_match is false, the experienceFitScore MUST be penalized heavily and capped below 60, regardless of the candidate's total years of general experience.
- All scores MUST be integers on a scale of 0 to 100.
- If a job's 'manualAts' is missing, identify the ATS system (e.g., Workday, Greenhouse). dejobs.org, Indeed, LinkedIn are NOT ATS systems. If unsure, return null.
- For 'travelScore', return a 0-100 score estimating travel.

STEP 4: OUTPUT
Return a strictly formatted JSON object containing: { updatedContextRules: string, processedContextJobIds: string[], jobScores: [{ id: string, required_domain: string, candidate_domain: string, domain_match: boolean, required_years_in_domain: number, candidate_years_in_domain: number, aimFitScore: number, aimFitReason: string, experienceFitScore: number, experienceFitReason: string, travelScore: number, atsSystem: string }] }. Output ONLY this JSON object inside a single markdown code block.`,
    resume: coreResume.text,
    contextProfile: {
      id: contextProfile?.id,
      rulesText: rulesText
    },
    contextUpdates: [], // empty for test
    jobsToScore: jobsToScore.map((j: any) => ({
      id: j.id, title: j.title, company: j.company, description: j.description, 
      location: j.location, url: j.url, manualAts: j.manualAts
    })),
    timestamp: new Date().toISOString()
  };

  console.log("Sending payload to DeepSeek...");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are a specialized AI recruiter parsing JSON to evaluate candidate fit." },
        { role: "user", content: JSON.stringify(payload) }
      ],
      temperature: 0,
      max_tokens: 4000,
      stream: false
    }),
  });

  if (!response.ok) {
    const txt = await response.text();
    console.error("DeepSeek API Error:", response.status, txt);
    return;
  }

  const responseData = await response.json();
  const textContent = responseData.choices?.[0]?.message?.content || '';

  const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = match ? match[1].trim() : textContent.trim();

  let parsedObj: any;
  try {
    parsedObj = JSON.parse(jsonStr);
  } catch(e) {
    console.error("Failed to parse output:", textContent);
    return;
  }

  console.log("\n==================== TEST RESULTS ====================\n");

  parsedObj.jobScores.forEach((aiJob: any) => {
    const original = jobsToScore.find((j: any) => j.id === aiJob.id);
    console.log(`Job: ${original?.title} @ ${original?.company}`);
    console.log(`OLD SCORES: Aim: ${original?.aimFitScore} | Exp: ${original?.reqFitScore}`);
    console.log(`NEW SCORES: Aim: ${aiJob.aimFitScore} | Exp: ${aiJob.experienceFitScore}`);
    console.log(`DOMAIN MATCH: ${aiJob.domain_match}`);
    console.log(`REQUIRED DOMAIN: ${aiJob.required_domain} (${aiJob.required_years_in_domain} yrs)`);
    console.log(`CANDIDATE DOMAIN: ${aiJob.candidate_domain} (${aiJob.candidate_years_in_domain} yrs)`);
    console.log(`REASON: ${aiJob.experienceFitReason}`);
    console.log("------------------------------------------------------\n");
  });
}

runTest().finally(() => prisma.$disconnect());
