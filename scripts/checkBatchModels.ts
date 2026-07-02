import { config } from 'dotenv';
config();

async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const data = await res.json();
  for (const model of data.models || []) {
    if (model.name.includes("flash")) {
      console.log(model.name, "->", model.supportedGenerationMethods?.join(","));
    }
  }
}
run();
