import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const testUrls = [
    'https://careers.google.com/jobs/results/90924976767664838-software-engineer-iii-google-cloud/', // Google Careers
    'https://openai.com/careers/software-engineer', // OpenAI
  ];

  for (const url of testUrls) {
    console.log(`Testing Jina API for URL: ${url}`);
  try {
      const res = await fetch(`https://r.jina.ai/${url}`);
      if (res.ok) {
        const text = await res.text();
        console.log(`SUCCESS! Extracted ${text.length} characters of markdown.`);
        console.log(text.substring(0, 500) + '...\n\n');
      } else {
        console.log(`FAILED with status ${res.status}`);
        const errText = await res.text();
        console.log(errText);
      }
    } catch (e) {
      console.error("Error fetching from Jina:", e);
    }
  }
}

run().finally(() => prisma.$disconnect());
