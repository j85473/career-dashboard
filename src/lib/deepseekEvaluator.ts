import { prisma } from './prisma';
import { getAllResumes } from './resume';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

export async function runDeepseekEvaluation(onProgress?: (msg: string) => void) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not set in the environment variables.');
  }

  onProgress?.('Fetching jobs for AI evaluation...');

  // 1. Get Resume
  const resumes = await getAllResumes();
  const coreResume = resumes[0];
  if (!coreResume) {
    throw new Error('No resume found.');
  }

  // 2. Get Context DB Rules
  const contextProfile = await prisma.contextProfile.findFirst();
  const rulesText = contextProfile?.rulesText || "No context rules found. Be lenient.";

  // 3. Get Context Updates (Jobs passed/applied that need context extraction)
  const contextUpdates = await prisma.job.findMany({
    where: {
      status: { in: ['passed', 'applied'] },
      contextBatched: false,
      description: { not: '' }
    },
    take: 5,
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      status: true,
      passReason: true,
    }
  });

  const jobsToScore = await prisma.job.findMany({
    where: {
      status: { in: ['inbox', 'pending_af'] },
      scoringStatus: 'scored',
      afBatchId: null,
      aimFitScore: null,
    },
    take: 5, // Reduced from 50 to prevent LLM truncation and context degradation
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      location: true,
      url: true,
      manualAts: true,
      status: true, // Fetch status here to avoid N+1 query later
      source: true,
    }
  });

  if (jobsToScore.length === 0 && contextUpdates.length === 0) {
    onProgress?.('No jobs pending for DeepSeek evaluation.');
    return { contextUpdated: false, contextJobsProcessed: 0, scoresProcessed: 0 };
  }

  const totalPending = await prisma.job.count({
    where: {
      status: { in: ['inbox', 'pending_af'] },
      scoringStatus: 'scored',
      afBatchId: null,
      aimFitScore: null,
    },
  });

  onProgress?.(`Sending ${jobsToScore.length} jobs to DeepSeek... (${totalPending} remaining)`);

  // Assemble payload
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
    contextUpdates,
    jobsToScore,
    timestamp: new Date().toISOString()
  };

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DeepSeek Strict Timeout Reached")), 60000));
  
  const fetchPromise = async () => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: "You are a specialized AI recruiter parsing JSON to evaluate candidate fit." },
            { role: "user", content: JSON.stringify(payload) }
          ],
          temperature: 0,
          stream: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${response.status} ${await response.text()}`);
      }
      return await response.json();
    } finally {
      clearTimeout(id);
    }
  };

  const responseData: any = await Promise.race([fetchPromise(), timeoutPromise]);
  const textContent = responseData.choices?.[0]?.message?.content || '';

  // Extract JSON from markdown
  const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = match ? match[1].trim() : textContent.trim();

  let parsedObj: any;
  try {
    parsedObj = JSON.parse(jsonStr);
  } catch(e) {
    console.error('Failed to parse DeepSeek JSON response. Raw response:', textContent);
    // Gracefully handle LLM hallucination by marking the jobs as dismissed so the pipeline doesn't infinite loop
    await prisma.job.updateMany({
      where: { id: { in: jobsToScore.map(j => j.id) } },
      data: { status: 'dismissed', scoringStatus: 'scored', aimFitScore: 0, passReason: 'DeepSeek hallucinated invalid JSON formatting.' }
    });
    return { contextUpdated: false, contextJobsProcessed: 0, scoresProcessed: 0 };
  }

  const { updatedContextRules, processedContextJobIds, jobScores } = parsedObj;

  let contextUpdated = false;
  let contextJobsProcessed = 0;
  let scoresProcessed = 0;

  onProgress?.('Applying AI outputs to the database...');

  // 1. Update Context DB
  if (updatedContextRules && typeof updatedContextRules === 'string') {
    const lowerRules = updatedContextRules.toLowerCase();
    if (lowerRules.includes('no changes') || lowerRules.includes('no updates') || lowerRules.includes('remain the same')) {
      console.log('Skipping context rules update (no changes detected by AI).');
    } else {
      if (contextProfile) {
        await prisma.contextProfile.update({
          where: { id: contextProfile.id },
          data: { rulesText: updatedContextRules }
        });
      } else {
        await prisma.contextProfile.create({
          data: { rulesText: updatedContextRules }
        });
      }
      contextUpdated = true;
    }
  }

  // 2. Mark Context Jobs as processed
  if (Array.isArray(processedContextJobIds) && processedContextJobIds.length > 0) {
    const res = await prisma.job.updateMany({
      where: { id: { in: processedContextJobIds } },
      data: { contextBatched: true }
    });
    contextJobsProcessed = res.count;
  }

  // 3. Process Job Scores
  if (Array.isArray(jobScores) && jobScores.length > 0) {
    const updatePromises = [];
    
    for (const scoreData of jobScores) {
      const jobId = scoreData.id;
      if (!jobId) continue;

      const aimFitScore = Math.round(Number(scoreData.aimFitScore)) || 0;
      const aimFitReason = scoreData.aimFitReason || '';
      const experienceFitScore = Math.round(Number(scoreData.experienceFitScore)) || 0;
      const experienceFitReason = scoreData.experienceFitReason || '';
      const travelScore = Math.round(Number(scoreData.travelScore)) || 0;
      const atsSystem = scoreData.atsSystem;
      
      const currentJob = jobsToScore.find(j => j.id === jobId);

      let passes = aimFitScore >= 80 && experienceFitScore >= 60;
      
      if (currentJob?.source === 'Manual Import') {
        passes = true; // Always drop manual imports into the inbox, but keep their real scores
      }
      
      if (currentJob) {
        let manualAts = currentJob.manualAts;
        if (atsSystem && (!manualAts || manualAts === 'Unknown' || manualAts === 'Unknown ATS')) {
          const invalidAts = ['dejobs', 'indeed', 'linkedin', 'glassdoor', 'ziprecruiter'];
          const isInvalid = invalidAts.some(invalid => atsSystem.toLowerCase().includes(invalid));
          if (!isInvalid) {
            manualAts = atsSystem;
          }
        }
        
        const updateData = passes ? {
          status: 'inbox',
          aimFitScore: aimFitScore,
          passReason: aimFitReason,
          reqFitScore: experienceFitScore,
          reqFitRationale: experienceFitReason,
          travelScore: travelScore,
          afBatchId: null,
          scoringStatus: 'scored',
          experienceStatus: 'scored',
          manualAts
        } : {
          status: 'dismissed',
          luckyStatus: 'pending', // Send to Wildcard evaluator if standard AI rejects it
          aimFitScore: aimFitScore,
          passReason: aimFitReason,
          reqFitScore: experienceFitScore,
          reqFitRationale: experienceFitReason,
          travelScore: travelScore,
          afBatchId: null,
          scoringStatus: 'scored',
          experienceStatus: 'scored',
          manualAts
        };

        updatePromises.push(prisma.job.update({
          where: { id: jobId },
          data: updateData
        }));
        
        scoresProcessed++;
      }
    }
    
    if (updatePromises.length > 0) {
      await prisma.$transaction(updatePromises);
    }
  }

  onProgress?.(`DeepSeek Evaluation Complete. Scored ${scoresProcessed} jobs.`);

  return { contextUpdated, contextJobsProcessed, scoresProcessed };
}
