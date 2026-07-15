import { prisma } from './prisma';
import { getAllResumes } from './resume';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

export async function runLuckyEvaluation(onProgress?: (msg: string) => void) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not set in the environment variables.');
  }

  onProgress?.('Fetching wildcard jobs for I\'m Feeling Lucky evaluation...');

  // 1. Get Resume (Channel Sales resume used for translatability check)
  const resumes = await getAllResumes();
  const coreResume = resumes[0];
  if (!coreResume) {
    throw new Error('No resume found.');
  }

  // 2. Get Wildcard Profile
  const wildcardProfile = await prisma.wildcardProfile.findFirst();
  const profileText = wildcardProfile?.profileText || "No wildcard profile found. Be lenient.";

  const jobsToScore = await prisma.job.findMany({
    where: {
      luckyStatus: 'pending',
      scoringStatus: 'scored',
      status: { not: 'archived' }
    },
    take: 10,
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      location: true,
      url: true,
      manualAts: true,
      source: true,
    }
  });

  if (jobsToScore.length === 0) {
    onProgress?.('No jobs pending for I\'m Feeling Lucky evaluation.');
    return { scoresProcessed: 0 };
  }

  const totalPending = await prisma.job.count({ where: { luckyStatus: 'pending' } });
  onProgress?.(`Sending ${jobsToScore.length} lucky jobs to DeepSeek... (${totalPending} remaining)`);

  // Assemble payload
  const payload = {
    _AI_INSTRUCTIONS: "🛑 SYSTEM OVERRIDE: RUTHLESS WILDCARD EVALUATION MODE 🛑\n\nCRITICAL INSTRUCTION: You are evaluating highly unconventional 'Wildcard' job postings against the user's 'Wildcard Profile' and their 'Resume'. The goal is to find unicorns.\n\n1) Vibe Alignment: Evaluate if the job heavily matches the Wildcard Profile. Look for extreme autonomy, builder mentality (0 to 1), and high travel if applicable. Use the Golden Exemplar in the profile as your benchmark.\n2) Translatability: The user's experience in the Resume MUST translate to this role.\n3) Hard Requirements Killer: If the job description explicitly lists a strict, non-negotiable hard requirement (e.g., Oncology sales experience, medical device experience, specific engineering degree, clinical background) that the candidate clearly lacks, you MUST severely penalize the experienceFitScore (give it < 50) and reject it. Do NOT pass them on 'translatability' if a hard industry requirement is missing.\n4) Hard Constraints: Assume US/Canada only and W2 unless stated otherwise.\n5) Compensation Killer: If the role is obviously hourly, in-store retail, basic sales associate, or if there is enough detail to confidently say the On-Target Earnings (OTE) / Total Compensation is below $80,000, INSTANTLY REJECT it regardless of vibe fit.\n6) Scoring: Return integer scores (0-100). For a job to pass, both vibeFitScore and experienceFitScore must be VERY HIGH (>= 85). We are being RUTHLESS.\n7) Return a strictly formatted JSON object containing: { jobScores: [{ id: string, vibeFitScore: number, vibeFitReason: string, experienceFitScore: number, experienceFitReason: string, passes: boolean }] }.\n8) Output ONLY this JSON object inside a single markdown code block.",
    resume: coreResume.text,
    wildcardProfile: profileText,
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
            { role: "system", content: "You are a specialized AI recruiter parsing JSON to ruthlessly evaluate wildcard candidate fit." },
            { role: "user", content: JSON.stringify(payload) }
          ],
          temperature: 0,
          stream: false,
          response_format: { type: 'json_object' }
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

  const match = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = match ? match[1].trim() : textContent.trim();
  
  let parsedObj: any;
  try {
    parsedObj = JSON.parse(jsonStr);
  } catch(e) {
    throw new Error('DeepSeek returned invalid JSON');
  }

  const { jobScores } = parsedObj;

  let scoresProcessed = 0;

  if (Array.isArray(jobScores) && jobScores.length > 0) {
    const updatePromises: any[] = [];
    const processedIds = new Set<string>();

    for (const scoreData of jobScores) {
      const jobId = scoreData.id;
      if (!jobId) continue;
      processedIds.add(jobId);

      const vibeFitScore = Math.round(Number(scoreData.vibeFitScore)) || 0;
      const vibeFitReason = scoreData.vibeFitReason || '';
      const experienceFitScore = Math.round(Number(scoreData.experienceFitScore)) || 0;
      const experienceFitReason = scoreData.experienceFitReason || '';
      const passes = vibeFitScore >= 85 && experienceFitScore >= 85;
      
      const updateData = passes ? {
        luckyStatus: 'inbox',
        luckyAimFitScore: vibeFitScore,
        luckyPassReason: `Vibe Fit: ${vibeFitReason}\n\nExperience Fit (${experienceFitScore}/100): ${experienceFitReason}`,
      } : {
        luckyStatus: 'dismissed',
        luckyAimFitScore: vibeFitScore,
        luckyPassReason: `[Wildcard Reject] Vibe Fit: ${vibeFitReason}\n\nExperience Fit (${experienceFitScore}/100): ${experienceFitReason}`,
      };

      updatePromises.push(prisma.job.updateMany({
        where: { id: jobId, luckyStatus: 'pending' },
        data: updateData
      }));
      
      scoresProcessed++;
    }

    // Handle any jobs that DeepSeek skipped or hallucinated away
    for (const job of jobsToScore) {
      if (!processedIds.has(job.id)) {
        updatePromises.push(prisma.job.updateMany({
          where: { id: job.id, luckyStatus: 'pending' },
          data: {
            luckyStatus: 'dismissed',
            luckyPassReason: '[Wildcard Reject] DeepSeek failed to return a score for this job.'
          }
        }));
      }
    }
    
    if (updatePromises.length > 0) {
      await prisma.$transaction(updatePromises);
    }
  }

  onProgress?.(`I'm Feeling Lucky Evaluation Complete. Scored ${scoresProcessed} wildcard jobs.`);

  return { scoresProcessed };
}
