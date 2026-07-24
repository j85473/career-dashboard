import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    // Batch polling has been moved to /api/linkedin/status

    const drafts = await prisma.linkedInDraft.findMany({
      orderBy: { createdAt: 'desc' },
      take: 3
    });
    return NextResponse.json({ options: drafts });
  } catch (error: unknown) {
    console.error('Failed to get or process LinkedIn drafts:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}

const LANES = [
  {
    name: "SaaS Channel & Partnerships",
    queries: ["SaaS channel sales", "B2B partner programs", "channel enablement tech", "cloud ecosystems", "PRM software trends"]
  },
  {
    name: "B2B GTM Strategy",
    queries: ["B2B go-to-market strategy", "SaaS indirect sales", "tech partner ecosystems", "channel partner recruitment", "SaaS distribution"]
  },
  {
    name: "Partner Operations",
    queries: ["partner operations SaaS", "partner incentives B2B", "channel sales data", "partner relationship management", "ecosystem ops"]
  }
];

import Parser from 'rss-parser';

export async function POST() {
  try {
    const recentUsed = await prisma.usedArticle.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const avoidUrls = recentUsed.map(a => a.url);

    // Use all 3 lanes to guarantee one of each
    const selectedLanes = LANES;
    
    // Fire and forget background task
    (async () => {
      try {

        
        // STEP 1: Use Google News RSS to find articles
        const parser = new Parser();
        const fetchedArticles = [];
        const verifiedUrls = [];
        const currentMonthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

        for (const lane of selectedLanes) {
            const baseQuery = lane.queries[Math.floor(Math.random() * lane.queries.length)];
            const q = encodeURIComponent(`${baseQuery} ${currentMonthYear}`);
            const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
            
            try {
                const feed = await parser.parseURL(rssUrl);
                const newsResults = feed.items || [];
                
                const validArticle = newsResults.find(article => {
                  const url = article.link || '';
                  return url.startsWith('http') && !avoidUrls.includes(url);
                });
                
                if (validArticle) {
                    fetchedArticles.push(`Domain: ${lane.name}\nTitle: ${validArticle.title || 'No Title'}\nURL: ${validArticle.link}\nSnippet: ${validArticle.contentSnippet || validArticle.content || ''}`);
                    verifiedUrls.push(validArticle.link);
                }
            } catch(e) {
                console.error("Failed to fetch Google News RSS for lane", lane.name, e);
            }
        }

        if (fetchedArticles.length === 0) {
          throw new Error("Failed to get any search results from Google News RSS.");
        }

        // STEP 2: Use DeepSeek (strict JSON) to draft posts based on the text

        const draftPrompt = `
You are helping with a LinkedIn posting routine. 
I have gathered recent news articles.

AVAILABLE ARTICLES TEXT:
${fetchedArticles.join('\n\n')}

VERIFIED URLs:
${verifiedUrls.join('\n')}

Your job is to draft exactly 3 LinkedIn posts (one for each article) in Joseph's voice.

VOICE GUIDELINES FOR JOSEPH
- Core principle: Direct, evidence-oriented, and sharply analytical. No fake warmth or corporate fluff.
- Structure & Depth: Start with a strong, definitive hook. Provide 1-2 key insights or data points from the article. Conclude with a clear takeaway or slightly contrarian perspective.
- Length: A solid 4-7 sentences that flow well, broken up for readability. We want depth and engagement.
- Tone: Confident, professional, and highly insightful. Write as if you've just realized a profound insight about the market or technology. 
- Evidence before tone: Specific numbers and findings over polished vagueness.
- Banned words: passionate, leverage, utilize, robust, synergy, seamless, empower, journey, landscape, thrilled, amazing, game-changer, transform, thought leadership, perfect fit.
- Banned patterns: Abstract bragging, fake optimism, vague professionalism.

CRITICAL RULES FOR THE URL:
1. You MUST use one of the VERIFIED URLs for each post.
2. DO NOT invent or hallucinate URLs. 

Return a JSON array of 3 objects with the following schema:
[
  {
    "title": "A short theme or title for the option",
    "postText": "The exact post text",
    "url": "One of the provided verified URLs"
  }
]
`;

        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
          },
          body: JSON.stringify({
            model: "deepseek-v4-pro",
            messages: [
              { role: "system", content: "You are helping with a LinkedIn posting routine. Output ONLY strict JSON." },
              { role: "user", content: draftPrompt }
            ],
            temperature: 0.1,
            stream: false,
            response_format: { type: 'json_object' }
          })
        });

        if (!response.ok) {
           const errText = await response.text();
           throw new Error("DeepSeek generation failed: " + errText);
        }

        const responseData = await response.json();
        const responseText = responseData.choices?.[0]?.message?.content || '[]';
        const cleanedText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
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

        }
      } catch (err) {
        console.error("Background LinkedIn generation failed:", err);
      }
    })();

    // Return immediately so mobile Safari doesn't timeout the connection
    return NextResponse.json({ status: "started", message: "Generation started in the background." });
  } catch (error: unknown) {
    console.error('Generate API error:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
