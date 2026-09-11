import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GoogleGenAI } from '@google/genai';
import Parser from 'rss-parser';
import {
  buildSourceBackedDraft,
  parseGeneratedDrafts,
  type LinkedInArticle,
  type LinkedInDraftOption,
} from '@/lib/linkedinPostGeneration';

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

async function findFreshArticle(
  lane: (typeof LANES)[number],
  avoidUrls: Set<string>,
): Promise<LinkedInArticle> {
  const baseQuery = lane.queries[Math.floor(Math.random() * lane.queries.length)];
  const currentMonthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const query = encodeURIComponent(`${baseQuery} ${currentMonthYear}`);
  const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(rssUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`News search returned HTTP ${response.status} for ${lane.name}.`);
  }

  const parser = new Parser();
  const feed = await parser.parseString(await response.text());
  const article = (feed.items || []).find(item => {
    const url = item.link?.trim() || '';
    return url.startsWith('http') && !avoidUrls.has(url.toLowerCase());
  });

  if (!article?.link) {
    throw new Error(`No fresh article was available for ${lane.name}.`);
  }

  return {
    lane: lane.name,
    title: article.title?.trim() || lane.name,
    url: article.link.trim(),
    snippet: article.contentSnippet || article.content || '',
  };
}

async function generateWithGemini(articles: LinkedInArticle[]): Promise<LinkedInDraftOption[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini is not configured.');

  const verifiedUrls = articles.map(article => article.url);
  const articleText = articles.map(article => [
    `Domain: ${article.lane}`,
    `Title: ${article.title}`,
    `URL: ${article.url}`,
    `Snippet: ${article.snippet}`,
  ].join('\n')).join('\n\n');

  const draftPrompt = `
Draft exactly one LinkedIn post for each of these three verified articles.

ARTICLES:
${articleText}

VOICE GUIDELINES FOR JOSEPH
- Direct, evidence-oriented, and sharply analytical. No fake warmth or corporate fluff.
- Start with a definitive hook, use 1-2 facts from the supplied article text, and close with a clear practical takeaway.
- Write 4-7 sentences, broken up for readability.
- Do not claim facts that are not in the supplied article text.
- Banned words: passionate, leverage, utilize, robust, synergy, seamless, empower, journey, landscape, thrilled, amazing, game-changer, transform, thought leadership, perfect fit.

URL RULES
- Use every supplied URL exactly once.
- Do not alter, invent, or replace any URL.

Return one JSON object in exactly this shape:
{"posts":[{"title":"Short theme","postText":"Exact post text","url":"Exact supplied URL"}]}
`;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: draftPrompt,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['posts'],
        properties: {
          posts: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'postText', 'url'],
              properties: {
                title: { type: 'string' },
                postText: { type: 'string' },
                url: { type: 'string' },
              },
            },
          },
        },
      },
    },
  });

  const responseText = response.text;
  if (!responseText) throw new Error('Gemini returned no draft content.');

  return parseGeneratedDrafts(responseText, verifiedUrls);
}

export async function POST() {
  try {
    const recentUsed = await prisma.usedArticle.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const avoidUrls = new Set(recentUsed.map(article => article.url.toLowerCase()));
    const articles = await Promise.all(LANES.map(lane => findFreshArticle(lane, avoidUrls)));

    let generationMode: 'ai' | 'source-backed-fallback' = 'ai';
    let drafts: LinkedInDraftOption[];
    try {
      drafts = await generateWithGemini(articles);
    } catch (error) {
      generationMode = 'source-backed-fallback';
      console.warn('LinkedIn AI drafting unavailable; using source-backed drafts:', error);
      drafts = articles.map(buildSourceBackedDraft);
    }

    await prisma.linkedInDraft.createMany({ data: drafts });

    return NextResponse.json({ options: drafts, generationMode });
  } catch (error: unknown) {
    console.error('Generate API error:', error);
    return NextResponse.json({
      error: 'Could not generate three fresh LinkedIn drafts. Please try again.',
    }, { status: 502 });
  }
}
