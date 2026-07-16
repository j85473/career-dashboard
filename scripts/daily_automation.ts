
import { prisma } from '../src/lib/prisma';
import { callGemini } from '../src/lib/gemini';
import { getSerpApiKeys, fetchWithKeyRotation } from '../src/lib/apiFallback';

// Set up env variables if not running through Next.js
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const LANES = [
  {
    name: "AI & Labor Market",
    queries: ["AI wages", "automation jobs", "workforce skills", "labor market trends", "tech hiring", "economic outlook"]
  },
  {
    name: "Healthcare & Medtech Industry",
    queries: ["FDA approval", "medical device recall", "CMS reimbursement", "medtech funding", "digital health", "clinical trial results"]
  },
  {
    name: "Medical Sales & Commercial Strategy",
    queries: ["medical device sales trends", "med sales rep hiring", "hospital buying behavior", "device adoption rate", "surgical rep productivity"]
  }
];

async function generateLinkedInDrafts() {
  console.log("Generating LinkedIn Drafts...");
  const usedArticles = await prisma.usedArticle.findMany();
  const usedUrls = new Set(usedArticles.map(a => a.url));

  const shuffledLanes = [...LANES].sort(() => 0.5 - Math.random());
  const selectedLanes = shuffledLanes.slice(0, 2);

  let candidates: any[] = [];
  const serpApiKeys = getSerpApiKeys();

  if (serpApiKeys.length === 0) {
    console.error("No SerpApi Key");
    return;
  }

  const fetchPromises = selectedLanes.map(async (lane) => {
    const query = lane.queries[Math.floor(Math.random() * lane.queries.length)];
    const serpRes = await fetchWithKeyRotation(serpApiKeys, async (key) => {
      const serpParams = new URLSearchParams({
        engine: 'google_news',
        q: query,
        api_key: key,
        gl: 'us',
        hl: 'en'
      });
      return fetch(`https://serpapi.com/search.json?${serpParams.toString()}`);
    });

    if (serpRes && serpRes.ok) {
      const data = await serpRes.json();
      const news = data.news_results || [];
      for (const item of news) {
        if (item.link) {
          let normalized = item.link.toLowerCase().trim();
          if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
          
          if (!usedUrls.has(normalized)) {
            candidates.push({
              title: item.title,
              source: item.source?.name || 'News Source',
              url: item.link,
              snippet: item.snippet || '',
              lane: lane.name
            });
          }
        }
      }
    }
  });

  await Promise.all(fetchPromises);

  if (candidates.length === 0) {
    console.error("No unused articles found.");
    return;
  }

  candidates = candidates.sort(() => 0.5 - Math.random()).slice(0, 10);

  const prompt = `
You are helping with a LinkedIn posting routine. 
Your job is to read the following unused news articles, pick the best ones, and draft 3 LinkedIn post options in Joseph's voice.

Articles:
${JSON.stringify(candidates, null, 2)}

VOICE GUIDELINES FOR JOSEPH
- Core principle: Direct, evidence-oriented, and sharply analytical. No fake warmth or corporate fluff.
- Structure & Depth: Start with a strong, definitive hook. Provide 1-2 key insights or data points from the article. Conclude with a clear takeaway or slightly contrarian perspective.
- Length: Do not make it too short or flat. A solid 4-7 sentences that flow well, perhaps broken up for readability, is ideal. We want depth and engagement, not just a passing comment.
- Tone: Confident, professional, and highly insightful. Write as if you've just realized a profound, contrarian, or highly valuable insight about the market or technology. Frame the post around this 'aha!' moment or deep industry realization to drive high engagement.
- Evidence before tone: Specific numbers and findings over polished vagueness.
- Banned words: passionate, leverage, utilize, robust, synergy, seamless, empower, journey, landscape, thrilled, amazing, game-changer, transform, thought leadership, perfect fit, excited to apply, fast-paced environment, dynamic team, proven track record.
- Banned patterns: Abstract bragging, fake optimism, vague professionalism, openers that warm up.

Select 3 distinct articles from at least 2 different lanes.
For each, draft a compelling, medium-length post with insightful commentary.

Return a JSON array of 3 objects with the following schema:
[
  {
    "title": "A short theme or title for the option",
    "postText": "The exact post text",
    "url": "The url of the article you chose from the list"
  }
]
`;

  const systemInstruction = "You are helping with a LinkedIn posting routine.";
  const responseText = await callGemini(prompt, systemInstruction, 3, 'gemini-2.5-pro');
  const parsed = JSON.parse(responseText || '[]');
  
  // Clear old drafts and save new ones safely in a transaction
  await prisma.$transaction([
    prisma.linkedInDraft.deleteMany({}),
    ...parsed.map((option: any) => prisma.linkedInDraft.create({
      data: {
        title: option.title,
        postText: option.postText,
        url: option.url
      }
    }))
  ]);
  
  console.log(`Saved ${parsed.length} new LinkedIn drafts.`);
}

async function runCron() {
  console.log("=== STARTING DAILY AUTOMATION ===");
  
  console.log("1. Generating LinkedIn Drafts...");
  await generateLinkedInDrafts();
  
  console.log("=== DAILY AUTOMATION COMPLETE ===");
}

runCron().catch(console.error);
