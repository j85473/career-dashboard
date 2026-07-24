const text = `
Apply here: https://jobs.lever.co/testcompany/1234
Or greenhouse: https://boards.greenhouse.io/testco/jobs/5678
Or ashby: https://jobs.ashbyhq.com/testco/91011
Or workday: https://test.wd1.myworkdayjobs.com/en-US/careers/job/123
`;

const match = text.match(/https:\/\/(?:jobs\.lever\.co|boards\.greenhouse\.io|jobs\.ashbyhq\.com|[\w-]+\.wd[\w-]*\.myworkdayjobs\.com|[\w-]+\.workable\.com|jobs\.smartrecruiters\.com)\/[^\s<)"]+/i);
console.log(match ? match[0] : 'No match');
