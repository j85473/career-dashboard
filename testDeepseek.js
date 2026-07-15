require('dotenv').config();
const apiKey = process.env.DEEPSEEK_API_KEY;
fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
  body: JSON.stringify({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "Please output JSON wrapped in a markdown code block." }]
  })
}).then(r => r.json()).then(json => console.log(json.choices[0].message)).catch(console.error);
