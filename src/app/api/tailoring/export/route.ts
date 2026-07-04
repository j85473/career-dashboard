import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { identifyAts } from '@/lib/atsUtils';

export async function GET() {
  try {
    const jobs = await prisma.job.findMany({
      where: { tailoringStaged: true }
    });

    const prefs = await prisma.userPreference.findMany();
    const globalRules = Array.from(new Set(prefs.map(p => `[${p.type.toUpperCase()}]: ${p.text}`)));

    const profile = await prisma.contextProfile.findUnique({ where: { id: 'global' } });
    if (profile) {
      globalRules.unshift(`[MASTER_PROFILE]:\n${profile.rulesText}`);
    }

    const now = new Date();
    const batchId = `batch_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

    const exportData = {
      _AI_INSTRUCTIONS: "# 🛑 SYSTEM OVERRIDE: MASSIVE CONCURRENT ORCHESTRATION (SWARM MODE) 🛑\n\nYou are the Orchestrator for the Resume Tailoring 6.0 Runtime. You have been provided with a batch of multiple jobs in the JSON below. \n\n**CRITICAL RULE: DO NOT PROCESS JOBS OR AGENTS SEQUENTIALLY. YOU MUST LAUNCH ALL AGENTS FOR ALL JOBS SIMULTANEOUSLY.**\n\n**YOUR DIRECTIVE:**\n1. **Calculate the Swarm:** For every job in the JSON, you require exactly 3 agents (Agent 1: Runtime Executor, Agent 2: Pre-Audit/Reconciler, Agent 3: Clean Semantic Auditor). For example, if there are 5 jobs, you must prepare exactly 15 subagents.\n2. **Massive Concurrent Launch:** You MUST make a **single tool call** to `invoke_subagent`, providing an array containing ALL 15+ subagents. This will launch them all concurrently. \n   - Assign clear `Role` names (e.g., `Job A - Executor`, `Job A - Reconciler`, etc.).\n   - In their initial `Prompt`, tell the Reconcilers and Auditors to stand by and wait for incoming data.\n3. **Dispatch Initial Work:** Once the swarm is launched and you receive all Conversation IDs, immediately use the `send_message` tool to concurrently send the specific job details to all of the \"Agent 1: Executors\" so they all begin drafting at the exact same time.\n4. **Act as the Central Switchboard:** \n   - As each Agent 1 finishes its draft, use `send_message` to forward its output to its corresponding Agent 2. \n   - Manage the reconciliation loops between Agent 1 and Agent 2 for all jobs simultaneously.\n   - As each Agent 2 approves a packet, forward it to its corresponding Agent 3.\n5. **DO NOT** do any of the resume tailoring work yourself. You are purely the massive parallel dispatcher and message router.\n\nAcknowledge these instructions, parse the JSON, and launch the entire swarm concurrently right now.",
      batch_id: batchId,
      global_rules: globalRules,
      jobs: jobs.map(j => ({
        job_id: j.id,
        company_name: j.company,
        job_title: j.title,
        job_url: j.url || j.canonicalUrl || '',
        ats_system: j.manualAts || identifyAts({ url: j.url || undefined, source: j.source || undefined }),
        job_description_text: j.description || '',
        target_baseline: j.recommendedResume || 'Core',
        job_specific_rules: j.tailoringAdvice ? [j.tailoringAdvice] : []
      }))
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${batchId}.json"`
      }
    });
  } catch (error) {
    console.error("Export failed", error);
    return NextResponse.json({ error: "Failed to export data" }, { status: 500 });
  }
}
