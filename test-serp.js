const apiKey = process.env.SERPAPI_KEY || "31121bfa9be2f48746e65589d3d06f755feef35310ad40f1ad565bc76be89590";
fetch(`https://serpapi.com/search.json?engine=google&q=site:boards.greenhouse.io&api_key=${apiKey}`)
  .then(res => res.json())
  .then(data => {
    const urls = data.organic_results?.map(r => r.link) || [];
    console.log(`Found ${urls.length} URLs`);
    console.log(urls.slice(0, 5));
  });
