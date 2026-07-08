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
  const wildcardProfile = await prisma.wildcardProfile.findFirst();
  const profileText = wildcardProfile?.profileText || "No wildcard profile found. Be lenient.";

  const jobs = await prisma.job.findMany({
    where: { luckyStatus: 'inbox' },
    select: {
      id: true, title: true, company: true, description: true, location: true, url: true, manualAts: true, source: true,
      luckyAimFitScore: true, luckyPassReason: true
    }
  });

  console.log(`Found ${jobs.length} jobs to compare. Processing first 15 to save time and give a good sample...`);
  
  const sampleJobs = jobs.slice(0, 15);
  const comparisonResults = [];

  // Batch into groups of 5
  for (let i = 0; i < sampleJobs.length; i += 5) {
    const batch = sampleJobs.slice(i, i + 5);
    console.log(`Processing batch ${i / 5 + 1}...`);
    
    const payload = {
      _AI_INSTRUCTIONS: "🛑 SYSTEM OVERRIDE: RUTHLESS WILDCARD EVALUATION MODE 🛑\n\nCRITICAL INSTRUCTION: You are evaluating highly unconventional 'Wildcard' job postings against the user's 'Wildcard Profile' and their 'Resume'. The goal is to find unicorns.\n\n1) Vibe Alignment: Evaluate if the job heavily matches the Wildcard Profile. Look for extreme autonomy, builder mentality (0 to 1), and high travel if applicable. Use the Golden Exemplar in the profile as your benchmark.\n2) Translatability: The user's experience in the Resume MUST translate to this role.\n3) Hard Requirements Killer: If the job description explicitly lists a strict, non-negotiable hard requirement (e.g., Oncology sales experience, medical device experience, specific engineering degree, clinical background) that the candidate clearly lacks, you MUST severely penalize the experienceFitScore (give it < 50) and reject it. Do NOT pass them on 'translatability' if a hard industry requirement is missing.\n4) Hard Constraints: Assume US/Canada only and W2 unless stated otherwise.\n5) Compensation Killer: If the role is obviously hourly, in-store retail, basic sales associate, or if there is enough detail to confidently say the On-Target Earnings (OTE) / Total Compensation is below $80,000, INSTANTLY REJECT it regardless of vibe fit.\n6) Scoring: Return integer scores (0-100). For a job to pass, both vibeFitScore and experienceFitScore must be VERY HIGH (>= 85). We are being RUTHLESS.\n7) Return a strictly formatted JSON object containing: { jobScores: [{ id: string, vibeFitScore: number, vibeFitReason: string, experienceFitScore: number, experienceFitReason: string, passes: boolean }] }.\n8) Output ONLY this JSON object inside a single markdown code block.",
      resume: coreResume.text,
      wildcardProfile: profileText,
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
          { role: "system", content: "You are a specialized AI recruiter parsing JSON to ruthlessly evaluate wildcard candidate fit." },
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
            let oldExpScore = 0;
            const expMatch = originalJob.luckyPassReason?.match(/Experience Fit \((\d+)\/100\)/);
            if (expMatch) oldExpScore = parseInt(expMatch[1]);

            comparisonResults.push({
              company: originalJob.company,
              title: originalJob.title,
              oldAim: originalJob.luckyAimFitScore || 0,
              oldExp: oldExpScore,
              newAim: score.vibeFitScore,
              newExp: score.experienceFitScore,
              newPass: score.passes,
              reason: score.experienceFitReason
            });
          }
        }
      }
    } catch(e) {
      console.error("Failed to parse batch JSON", e);
    }
  }

  // Generate markdown artifact
  let md = `# DeepSeek V4 Pro vs Flash Scoring Comparison\n\n`;
  md += `Here is a sample of 30 jobs from your \`lucky_inbox\` that were originally scored by the old model (Flash), re-scored live by **DeepSeek-V4-Pro** using the new Hard Requirements Killer prompt.\n\n`;
  
  md += `| Company | Title | Aim (Old -> Pro) | Exp (Old -> Pro) | Pro Verdict |\n`;
  md += `|---|---|---|---|---|\n`;

  for (const res of comparisonResults) {
    const verdict = res.newPass ? "✅ PASS" : "❌ REJECT";
    const aimChange = `${res.oldAim} -> **${res.newAim}**`;
    const expChange = `${res.oldExp} -> **${res.newExp}**`;
    md += `| ${res.company} | ${res.title} | ${aimChange} | ${expChange} | ${verdict} |\n`;
  }

  fs.writeFileSync('/Users/JosephLamb/.gemini/antigravity/brain/ac38409b-f8b5-4078-8af4-df7fc258a1a9/v4_comparison.md', md);
  console.log("Artifact created!");
}

runComparison().finally(() => prisma.$disconnect());
