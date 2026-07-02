import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LANES = [
  {
    name: "AI & Labor Market",
    queries: ["AI wages", "automation jobs", "workforce skills", "labor market trends", "tech hiring", "economic outlook"]
  },
  {
    name: "Medical Sales & Commercial Strategy",
    queries: ["medical device sales trends", "med sales rep hiring", "hospital buying behavior", "device adoption rate", "surgical rep productivity"]
  },
  {
    name: "B2B Channel & Distribution Sales",
    queries: ["channel sales strategy", "distribution network growth", "B2B sales trends", "partner enablement", "supply chain sales"]
  }
];

export async function POST() {
  try {
    const recentUsed = await prisma.usedArticle.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const avoidUrls = recentUsed.map(a => a.url);

    const prompt = `You are helping with a LinkedIn posting routine. 
Your job is to use your Google Search capabilities to find 3 recent, highly relevant news articles. You must find exactly ONE article for EACH of the following 3 domains:

Domain 1: ${LANES[0].name} (Focus areas: ${LANES[0].queries.join(', ')})
Domain 2: ${LANES[1].name} (Focus areas: ${LANES[1].queries.join(', ')})
Domain 3: ${LANES[2].name} (Focus areas: ${LANES[2].queries.join(', ')})

IMPORTANT: Do NOT use any of these recently used URLs:
${avoidUrls.join('\n')}

Once you have found 3 excellent articles across these domains, draft a LinkedIn post for each one in Joseph's voice.

VOICE GUIDELINES FOR JOSEPH
- Core principle: Direct, evidence-oriented, and sharply analytical. No fake warmth or corporate fluff.
- Structure & Depth: Start with a strong, definitive hook. Provide 1-2 key insights or data points from the article. Conclude with a clear takeaway or slightly contrarian perspective.
- Length: Do not make it too short or flat. A solid 4-7 sentences that flow well, perhaps broken up for readability, is ideal. We want depth and engagement, not just a passing comment.
- Tone: Confident, professional, and highly insightful. Write as if you've just realized a profound, contrarian, or highly valuable insight about the market or technology. Frame the post around this 'aha!' moment or deep industry realization to drive high engagement.
- Evidence before tone: Specific numbers and findings over polished vagueness.
- Banned words: passionate, leverage, utilize, robust, synergy, seamless, empower, journey, landscape, thrilled, amazing, game-changer, transform, thought leadership, perfect fit, excited to apply, fast-paced environment, dynamic team, proven track record.
- Banned patterns: Abstract bragging, fake optimism, vague professionalism, openers that warm up.

CRITICAL RULES FOR THE URL AND FACTS:
1. You MUST use real, recent news articles you found via Google Search.
2. Do NOT hallucinate, guess, or invent the "url". It MUST be the exact, valid, clickable link copy-pasted directly from your search results.
3. If an article mentions a report (like a 2024 or 2025 report), do not hallucinate a future year (e.g., 2026) just because the current year is 2026. Stick strictly to the facts in the article.

Return a JSON array of 3 objects with the following schema. Return ONLY the raw JSON array starting with '[' and ending with ']'. Do NOT wrap it in markdown code blocks (\`\`\`json).
[
  {
    "title": "A short theme or title for the option",
    "postText": "The exact post text",
    "url": "The EXACT, real url of the article directly from your search results"
  }
]`;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
      config: {
        temperature: 0.1,
        tools: [{ googleSearch: {} }]
      }
    });

    let rawText = response.text || '[]';
    // Clean up any markdown that the model might still try to inject
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    const posts = JSON.parse(rawText || '[]');
    
    for (const post of posts) {
      await prisma.linkedInDraft.create({
        data: {
          title: post.title,
          postText: post.postText,
          url: post.url
        }
      });
      await prisma.usedArticle.create({
        data: {
          url: post.url,
          status: 'drafted'
        }
      });
    }

    return NextResponse.json({ message: 'LinkedIn Drafts generated successfully', count: posts.length });
  } catch (error: any) {
    console.error('LinkedIn Batch Submit failed:', error);
    return NextResponse.json({ error: 'Failed to submit batch', details: error.message }, { status: 500 });
  }
}
