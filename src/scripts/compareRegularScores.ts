import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import "dotenv/config";
import { getAllResumes } from '../lib/resume';

const prisma = new PrismaClient();
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

async function runComparison() {
  if (!DEEPSEEK_API_KEY) throw new Error("No API Key");

  const resumes = await getAllResumes();
  const coreResume = resumes[0];
  const contextProfile = await prisma.contextProfile.findFirst();
  const rulesText = contextProfile?.rulesText || "No context rules found.";

  // Find 15 jobs that were already scored (so we can compare to old scores)
  const jobs = await prisma.job.findMany({
    where: { 
      scoringStatus: 'scored',
      reqFitScore: { not: null },
      aimFitScore: { not: null },
    },
    take: 15,
    orderBy: {
      createdAt: 'desc'
    },
    select: {
      id: true, title: true, company: true, description: true, location: true, url: true, manualAts: true, source: true, status: true,
      aimFitScore: true, passReason: true, reqFitScore: true, reqFitRationale: true
    }
  });

  console.log(`Found ${jobs.length} jobs to compare. Processing 15 jobs in batches of 5...`);
  
  const comparisonResults = [];

  for (let i = 0; i < jobs.length; i += 5) {
    const batch = jobs.slice(i, i + 5);
    console.log(`Processing batch ${i / 5 + 1}...`);
    
    const payload = {
      _AI_INSTRUCTIONS: "🛑 SYSTEM OVERRIDE: STRICT AI EVALUATION MODE 🛑\n\nCRITICAL INSTRUCTION: You are an AI assistant processing this A/E Fit scoring batch. You MUST use your advanced semantic reasoning capabilities to evaluate each job individually against the provided 'resume' and 'contextProfile'.\n\n1) Read 'contextUpdates' and update your internal understanding of the user's Context DB.\n2) Evaluate every single job in 'jobsToScore' based strictly on the nuances of the Context DB rules and the Resume. Do not take shortcuts.\n3) All scores MUST be integers on a scale of 0 to 100.\n4) If a job's 'manualAts' is missing or unknown, carefully analyze its 'description' and 'url' to identify the likely ATS system (e.g., Workday, Greenhouse, Lever, Ashby, etc.). Note: dejobs.org, Indeed, LinkedIn, and corporate websites (like Deloitte or Google) are NOT ATS systems. If you cannot confidently identify a true ATS platform, return null. Do NOT return the company name as the ATS system.\n5) Return a strictly formatted JSON object containing: { updatedContextRules: string, processedContextJobIds: string[], jobScores: [{ id: string, aimFitScore: number, aimFitReason: string, experienceFitScore: number, experienceFitReason: string, travelScore: number, atsSystem: string }] }.\n6) Output ONLY this JSON object inside a single markdown code block. Do NOT include any conversational filler.",
      resume: coreResume.text,
      contextProfile: {
        id: contextProfile?.id,
        rulesText: rulesText
      },
      contextUpdates: [],
      jobsToScore: batch,
      timestamp: new Date().toISOString()
    };

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(300000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [
          { role: "system", content: "You are a specialized AI recruiter parsing JSON to evaluate candidate fit." },
          { role: "user", content: JSON.stringify(payload) }
        ],
        temperature: 0,
        stream: false,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      console.error("DeepSeek API error:", await response.text());
      continue;
    }

    const responseData = await response.json();
    const textContent = responseData.choices?.[0]?.message?.content || '';
    const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = match ? match[1].trim() : textContent.trim();
    
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.jobScores) {
        for (const score of parsed.jobScores) {
          const originalJob = batch.find(j => j.id === score.id);
          if (originalJob) {
            comparisonResults.push({
              company: originalJob.company,
              title: originalJob.title,
              oldAim: originalJob.aimFitScore || 0,
              oldExp: originalJob.reqFitScore || 0,
              newAim: score.aimFitScore,
              newExp: score.experienceFitScore,
            });
          }
        }
      }
    } catch(e) {
      console.error("Failed to parse batch JSON", e);
    }
  }

  // Generate markdown artifact
  let md = `# DeepSeek V4 Pro vs Flash (Regular Scoring)\n\n`;
  md += `Here is a sample of 15 standard jobs that went through the standard context scoring (not I'm Feeling Lucky), re-scored live by **DeepSeek-V4-Pro**.\n\n`;
  
  md += `| Company | Title | Aim (Flash -> Pro) | Exp (Flash -> Pro) |\n`;
  md += `|---|---|---|---|\n`;

  for (const res of comparisonResults) {
    const aimChange = `${res.oldAim} -> **${res.newAim}**`;
    const expChange = `${res.oldExp} -> **${res.newExp}**`;
    md += `| ${res.company} | ${res.title} | ${aimChange} | ${expChange} |\n`;
  }

  fs.writeFileSync('/Users/JosephLamb/.gemini/antigravity/brain/ac38409b-f8b5-4078-8af4-df7fc258a1a9/v4_regular_comparison.md', md);
  console.log("Artifact created!");
}

runComparison().finally(() => prisma.$disconnect());
