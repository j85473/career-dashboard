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
  const coreResume = resumes.find(r => r.name === 'Core') || resumes[0];
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
    take: 20,
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
    }
  });

  const jobsToScore = await prisma.job.findMany({
    where: {
      status: 'pending_af',
      scoringStatus: 'scored',
      afBatchId: null,
    },
    take: 10, // Reduced from 50 to prevent LLM truncation and context degradation
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      location: true,
      url: true,
      manualAts: true,
      status: true, // Fetch status here to avoid N+1 query later
    }
  });

  if (jobsToScore.length === 0 && contextUpdates.length === 0) {
    onProgress?.('No jobs pending for DeepSeek evaluation.');
    return { contextUpdated: false, contextJobsProcessed: 0, scoresProcessed: 0 };
  }

  onProgress?.(`Sending ${jobsToScore.length} jobs and ${contextUpdates.length} context updates to DeepSeek...`);

  // Assemble payload
  const payload = {
    _AI_INSTRUCTIONS: "🛑 SYSTEM OVERRIDE: STRICT AI EVALUATION MODE 🛑\n\nCRITICAL INSTRUCTION: You are an AI assistant processing this A/E Fit scoring batch. You MUST use your advanced semantic reasoning capabilities to evaluate each job individually against the provided 'resume' and 'contextProfile'.\n\n1) Read 'contextUpdates' and update your internal understanding of the user's Context DB.\n2) Evaluate every single job in 'jobsToScore' based strictly on the nuances of the Context DB rules and the Resume. Do not take shortcuts.\n3) All scores MUST be integers on a scale of 0 to 100.\n4) If a job's 'manualAts' is missing or unknown, carefully analyze its 'description' and 'url' to identify the likely ATS system (e.g., Workday, Greenhouse, Lever, etc.). Note: dejobs.org, Indeed, and LinkedIn are job boards, NOT ATS systems. Do not list them as the ATS.\n5) Return a strictly formatted JSON object containing: { updatedContextRules: string, processedContextJobIds: string[], jobScores: [{ id: string, aimFitScore: number, aimFitReason: string, experienceFitScore: number, experienceFitReason: string, travelScore: number, atsSystem: string }] }.\n6) Output ONLY this JSON object inside a single markdown code block. Do NOT include any conversational filler.",
    resume: coreResume.text,
    contextProfile: {
      id: contextProfile?.id,
      rulesText: rulesText
    },
    contextUpdates,
    jobsToScore,
    timestamp: new Date().toISOString()
  };

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
      stream: false,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} ${errorText}`);
  }

  const responseData = await response.json();
  const textContent = responseData.choices?.[0]?.message?.content || '';

  // Extract JSON from markdown
  const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = match ? match[1].trim() : textContent.trim();
  
  let parsedObj: any;
  try {
    parsedObj = JSON.parse(jsonStr);
  } catch(e) {
    console.error('Failed to parse DeepSeek JSON response', textContent);
    throw new Error('DeepSeek returned invalid JSON');
  }

  const { updatedContextRules, processedContextJobIds, jobScores } = parsedObj;

  let contextUpdated = false;
  let contextJobsProcessed = 0;
  let scoresProcessed = 0;

  onProgress?.('Applying AI outputs to the database...');

  // 1. Update Context DB
  if (updatedContextRules && typeof updatedContextRules === 'string') {
    const existing = await prisma.contextProfile.findFirst();
    if (existing) {
      await prisma.contextProfile.update({
        where: { id: existing.id },
        data: { rulesText: updatedContextRules }
      });
    } else {
      await prisma.contextProfile.create({
        data: { rulesText: updatedContextRules }
      });
    }
    contextUpdated = true;
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
      
      const passes = aimFitScore >= 70 && experienceFitScore >= 50;

      const currentJob = jobsToScore.find(j => j.id === jobId);
      
      if (currentJob) {
        const shouldUpdateStatus = currentJob.status === 'pending_af';
        let manualAts = currentJob.manualAts;
        if (atsSystem && (!manualAts || manualAts === 'Unknown' || manualAts === 'Unknown ATS')) {
          const invalidAts = ['dejobs', 'indeed', 'linkedin', 'glassdoor', 'ziprecruiter'];
          const isInvalid = invalidAts.some(invalid => atsSystem.toLowerCase().includes(invalid));
          if (!isInvalid) {
            manualAts = atsSystem;
          }
        }
        
        const updateData = passes ? {
          ...(shouldUpdateStatus ? { status: 'inbox' } : {}),
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
          ...(shouldUpdateStatus ? { status: 'dismissed' } : {}),
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
