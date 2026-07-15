import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const type = url.searchParams.get('type') || 'email'; // 'email' or 'note'
    
    const target = await prisma.outreachTarget.findUnique({ where: { id } });

    if (!target) {
      return NextResponse.json({ error: 'Target not found' }, { status: 404 });
    }

    let prompt = '';

    if (type === 'note') {
      prompt = `
You are drafting a LinkedIn connection request note for Joseph Lamb, a channel sales operator with 6+ years at AT&T, looking to pivot into SaaS channel sales.

INSTRUCTIONS:
1. Write a very brief, casual connection request note to ${target.firstName} who works at ${target.company || 'their company'}.
2. Mention your background briefly (e.g. 6 yrs managing AT&T channel execution across 155 locations).
3. Express interest in connecting to learn about their partner ecosystem or enablement friction points.
4. STRICT LENGTH LIMIT: The entire message MUST be under 300 characters total. This is a hard limit for LinkedIn connection notes.
5. Do NOT include a Subject line.
6. Do NOT include "Body:" or any other labels.
7. ONLY return the raw message text.

First Name: ${target.firstName}
Company: ${target.company || 'your company'}
Headline: ${target.headline}
`;
    } else {
      prompt = `
You are drafting a cold outreach email for Joseph Lamb, a channel sales operator with 6+ years at AT&T, looking to pivot into SaaS channel sales.

Here is the "Enablement & Friction" template:
Subject: Scaling partner enablement at [Company] / Intro from AT&T Channel

Body:
Hi [Name], 

I'm reaching out because I saw you're leading the partner ecosystem at [Company]. I recently spent 6 years managing AT&T’s channel execution across 155 distributor locations (growing that network 15% YoY), so I know firsthand the friction points involved in getting field reps to actually adopt a new GTM motion. 

I'm currently looking to transition my channel operations experience into SaaS. I’d love 10 minutes to learn about your ecosystem's biggest enablement bottlenecks right now and see if there are any mutual synergies. 

Open to a brief chat later this week?

Best,
Joseph Lamb

INSTRUCTIONS:
1. Replace "[Name]" with the First Name provided below.
2. Replace "[Company]" with the Company provided below.
3. HUMANIZATION RULE: Rewrite the template slightly to sound extremely natural, casual, and written by a real human. Do NOT use overly formal AI language, buzzwords, or corporate jargon. Keep it brief and conversational, like a quick, direct LinkedIn message from one professional to another. Do not sound like a marketing email.
4. Keep the core metric (growing AT&T's network 15% YoY across 155 locations).
5. Ensure the email is reasonably brief but it does NOT have a strict character limit.

First Name: ${target.firstName}
Company: ${target.company || 'your company'}
Headline: ${target.headline}

Return ONLY the final drafted Subject and Body. Do not include any other commentary.
`;
    }

    // Call DeepSeek API
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro', // Using the v4 pro model as requested
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("DeepSeek API error:", errText);
      return NextResponse.json({ error: 'DeepSeek API error' }, { status: 500 });
    }

    const data = await response.json();
    const generatedText = data.choices[0]?.message?.content || '';

    // Save it to the database
    let updated;
    if (type === 'note') {
      updated = await prisma.outreachTarget.update({
        where: { id },
        data: { generatedNote: generatedText }
      });
    } else {
      updated = await prisma.outreachTarget.update({
        where: { id },
        data: { generatedPitch: generatedText }
      });
    }

    return NextResponse.json(updated);
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
