import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { callGemini } from '@/lib/gemini';

export async function GET() {
  try {
    // Batch polling has been moved to /api/linkedin/status

    const drafts = await prisma.linkedInDraft.findMany({
      orderBy: { createdAt: 'desc' },
      take: 3
    });
    return NextResponse.json({ options: drafts });
  } catch (error: any) {
    console.error('Failed to get or process LinkedIn drafts:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

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

export async function POST() {
  try {
    const recentUsed = await prisma.usedArticle.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const avoidUrls = recentUsed.map(a => a.url);

    // Pick 2 random lanes
    const shuffledLanes = [...LANES].sort(() => 0.5 - Math.random());
    const selectedLanes = shuffledLanes.slice(0, 2);
    
    const serpApiKey = process.env.SERPAPI_KEY || process.env.SERPAPI_KEY_2;
    if (!serpApiKey) {
      throw new Error("Missing SERPAPI_KEY");
    }

    // Fire and forget background task
    (async () => {
      try {
        console.log("Starting background LinkedIn generation...");
        
        // STEP 1: Use Gemini Search to find articles (No JSON restriction)
        const searchPrompt = `
You are a research assistant. Use Google Search to find 3 recent, highly relevant news articles related to these domains:
${selectedLanes.map(l => l.name).join(', ')}

IMPORTANT: Do NOT use any of these recently used URLs:
${avoidUrls.join('\n')}

Format your output EXACTLY like this for each article, in plain text:
Title: [Article Title]
URL: [Exact, valid, clickable URL from search results]
Snippet: [A short summary or snippet from the article]
`;
        const searchSystemInstruction = "You are a research assistant finding news articles.";
        
        console.log("Fetching articles via Gemini search...");
        const searchResults = await callGemini(searchPrompt, searchSystemInstruction, 3, 'gemini-2.5-pro', true);
        
        if (!searchResults) {
          throw new Error("Failed to get search results from Gemini.");
        }

        // STEP 2: Use Gemini (without search, strict JSON) to draft posts based on the text
        console.log("Drafting posts from search results...");
        const draftPrompt = `
You are helping with a LinkedIn posting routine. 
I have gathered 3 recent news articles.

AVAILABLE ARTICLES:
${searchResults}

Your job is to draft a LinkedIn post for each of the 3 articles in Joseph's voice.

VOICE GUIDELINES FOR JOSEPH
- Core principle: Direct, evidence-oriented, and sharply analytical. No fake warmth or corporate fluff.
- Structure & Depth: Start with a strong, definitive hook. Provide 1-2 key insights or data points from the article. Conclude with a clear takeaway or slightly contrarian perspective.
- Length: A solid 4-7 sentences that flow well, broken up for readability. We want depth and engagement.
- Tone: Confident, professional, and highly insightful. Write as if you've just realized a profound insight about the market or technology. 
- Evidence before tone: Specific numbers and findings over polished vagueness.
- Banned words: passionate, leverage, utilize, robust, synergy, seamless, empower, journey, landscape, thrilled, amazing, game-changer, transform, thought leadership, perfect fit.
- Banned patterns: Abstract bragging, fake optimism, vague professionalism.

CRITICAL RULES FOR THE URL:
1. You MUST use the exact URLs provided in the AVAILABLE ARTICLES list above.
2. DO NOT invent or hallucinate URLs. Copy-paste the 'URL' field exactly.

Return a JSON array of 3 objects with the following schema:
[
  {
    "title": "A short theme or title for the option",
    "postText": "The exact post text",
    "url": "The EXACT, real url of the article you selected from the list"
  }
]
`;

        const draftSystemInstruction = "You are helping with a LinkedIn posting routine.";
        const responseText = await callGemini(draftPrompt, draftSystemInstruction, 3, 'gemini-2.5-pro', false); // No search needed, we did it
        
        const cleanedText = responseText?.replace(/```json/g, '').replace(/```/g, '').trim() || '[]';
        const parsed = JSON.parse(cleanedText);

        if (Array.isArray(parsed) && parsed.length > 0) {
          // Save to DB!
          for (const draft of parsed) {
             await prisma.linkedInDraft.create({
               data: {
                 title: draft.title,
                 postText: draft.postText,
                 url: draft.url
               }
             });
          }
          console.log("Successfully generated and saved LinkedIn drafts.");
        }
      } catch (err) {
        console.error("Background LinkedIn generation failed:", err);
      }
    })();

    // Return immediately so mobile Safari doesn't timeout the connection
    return NextResponse.json({ status: "started", message: "Generation started in the background." });
  } catch (error: any) {
    console.error('Generate API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

