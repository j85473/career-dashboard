import 'dotenv/config';

async function main() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
  const data = await res.json();
  const batchModels = data.models.filter((m: any) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('batchGenerateContent'));
  console.log('Batch Models:', batchModels.map((m: any) => m.name));
}
main().catch(console.error);
