import { prisma } from './prisma';
import { callGemini } from './gemini';

export async function updateContextProfile(jobId: string, action: 'applied' | 'passed', reason?: string) {
  try {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;

    let profile = await prisma.contextProfile.findUnique({ where: { id: 'global' } });
    if (!profile) {
      profile = await prisma.contextProfile.create({
        data: {
          id: 'global',
          rulesText: 'DO ACCEPT:\n- B2B Sales, territory management, account executive, medical device, software, SaaS roles.\n\nDO REJECT:\n- Inside sales, retail sales, B2C, entry-level, door-to-door, nursing, developer, contractor/1099 roles.'
        }
      });
    }

    const prompt = `
You are an AI maintaining a Master Preference Profile for a job seeker.
The user just manually reviewed a job and took an action.

ACTION: ${action.toUpperCase()}
USER'S STATED REASON (if any): ${reason || 'None provided'}

JOB TITLE: ${job.title}
COMPANY: ${job.company}
DESCRIPTION SNIPPET:
${job.description?.substring(0, 1000)}

CURRENT MASTER PREFERENCE PROFILE:
${profile.rulesText}

INSTRUCTIONS:
Based on this new action, refine and update the Master Preference Profile.
If they passed on it, extract the pattern and add it to DO REJECT.
If they applied to it, extract the pattern and add it to DO ACCEPT.
Keep it concise, removing redundant points.
You must return a JSON object with a single field "rulesText" containing the updated profile string.
    `;

    const responseText = await callGemini(prompt, 'You are a meticulous AI profile builder.');
    if (responseText) {
      try {
        const cleanedText = responseText.replace(/^```(?:json)?\\s*/i, '').replace(/```\\s*$/i, '').trim();
        const data = JSON.parse(cleanedText);
        if (data.rulesText) {
          const lowerRules = data.rulesText.toLowerCase();
          if (!lowerRules.includes('no changes') && lowerRules.trim().length > 10) {
            await prisma.contextProfile.update({
              where: { id: 'global' },
              data: { rulesText: data.rulesText.trim() }
            });
          }
        }
      } catch (e) {
        console.error("Failed to parse Gemini context update", e);
      }
    }
  } catch (error) {
    console.error("Failed to update context profile:", error);
  }
}
