import { prisma } from "../src/lib/prisma";
import { callGemini } from "../src/lib/gemini";
import * as fs from 'fs';

async function main() {
  console.log("Fetching pending jobs for analysis...");

  const deepseekJobs = await prisma.job.findMany({
    where: { scoringStatus: 'scored', status: { in: ['inbox', 'pending_af'] }, aimFitScore: null },
    select: { id: true, title: true, company: true }
  });
  
  console.log(`Found ${deepseekJobs.length} jobs to analyze.`);
  
  const BATCH_SIZE = 200;
  const junkPatterns = [];
  
  for (let i = 0; i < deepseekJobs.length; i += BATCH_SIZE) {
    const batch = deepseekJobs.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${i / BATCH_SIZE + 1} of ${Math.ceil(deepseekJobs.length / BATCH_SIZE)}...`);
    
    const prompt = `
      You are a Data Quality Manager. We have a list of job postings. 
      Many of these jobs are "junk" that we want to filter out (e.g., healthcare, retail, manual labor, low-level admin, entry-level, very unrelated industries).
      The user is looking for mid-to-senior tech-adjacent or business/strategy roles (but NOT software engineering).

      Analyze the following batch of jobs. Identify the ones that are CLEARLY junk and categorize the REASONS why they are junk (e.g., specific titles, industries, keywords).
      Output a JSON object with a list of "junkCategories" found in this batch, and for each category, provide the common "keywords" or "titlePatterns" that could be used in a regex to filter them out.
      
      Jobs:
      ${JSON.stringify(batch)}
      
      Output format:
      {
        "junkCategories": [
          { "category": "Retail", "titlePatterns": ["cashier", "store manager"] }
        ]
      }
    `;
    
    try {
      const responseText = await callGemini(prompt, "You are an expert data analyst.");
      const jsonStr = responseText?.replace(/```json\n/g, '').replace(/```\n?/g, '').trim();
      if (jsonStr) {
        const result = JSON.parse(jsonStr);
        if (result.junkCategories) {
          junkPatterns.push(...result.junkCategories);
        }
      }
    } catch (e) {
      console.error(`Error processing batch:`, e);
    }
  }

  // Aggregate and save results
  const aggregated: Record<string, Set<string>> = {};
  for (const item of junkPatterns) {
    if (!aggregated[item.category]) aggregated[item.category] = new Set();
    if (Array.isArray(item.titlePatterns)) {
      item.titlePatterns.forEach((p: string) => aggregated[item.category].add(p.toLowerCase()));
    }
  }
  
  const finalOutput: Record<string, string[]> = {};
  for (const [cat, set] of Object.entries(aggregated)) {
    finalOutput[cat] = Array.from(set);
  }
  
  fs.writeFileSync('junk_patterns.json', JSON.stringify(finalOutput, null, 2));
  console.log("Analysis complete. Saved to junk_patterns.json");
}

main().catch(console.error).finally(() => prisma.$disconnect());
