import { config } from 'dotenv';
config();

async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  const jsonl = '{"id":"1","request":{"contents":[{"role":"user","parts":[{"text":"Hi"}]}]}}\n{"id":"2","request":{"contents":[{"role":"user","parts":[{"text":"Hi 2"}]}]}}\n';

  const reqBody = Buffer.from(jsonl);
  
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=${apiKey}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/jsonl',
    },
    body: reqBody
  });
  
  console.log("Status:", uploadRes.status);
  console.log("Text:", await uploadRes.text());
}

run();
