# GitHub Job Scraping Strategy

This document outlines the plan for ingesting job postings natively from GitHub.

## Overview
GitHub is a goldmine for hidden jobs. Many startups and open-source companies post roles in GitHub Issues (e.g., using a `hiring` label) or in massive curated repositories like `awesome-jobs`. 

## 1. The Strategy: GitHub REST API
We do not need to scrape HTML. We can use the official GitHub REST API.

**Target 1: Global Issue Search**
We will hit the GitHub Search API for Issues that are currently open and have labels or titles indicating hiring.
- **Endpoint:** `GET https://api.github.com/search/issues`
- **Query Parameters (`q`):**
  - `is:open`
  - `is:issue`
  - `label:hiring` OR `label:"job board"`
  - `"we are hiring" in:title,body`
- **Sort:** `created` (descending) to get the freshest jobs.

**Target 2: Specific "Who is Hiring" Repositories**
Some repositories are dedicated entirely to job postings.
- e.g., `poteto/hiring-without-whiteboards`
- e.g., `awesome-jobs` repositories.
- We can fetch issues directly from these known repos: `GET /repos/{owner}/{repo}/issues`

## 2. Implementation Steps
1. **Create an API Route:** Create `src/app/api/pipeline/github/route.ts`.
2. **Fetch Data:** 
   - Make a `fetch` call to the GitHub Search API.
   - Example URL: `https://api.github.com/search/issues?q=is:open+is:issue+label:hiring&sort=created&order=desc&per_page=30`
   - *Optional but recommended:* Use a GitHub Personal Access Token (PAT) passed via `Authorization: Bearer <TOKEN>` in the headers to avoid aggressive rate-limiting (unauthenticated limit is 10 requests/minute, authenticated is 30/minute for search).
3. **Parse and Normalize:**
   - Iterate through `response.items`.
   - `title` -> Job Title
   - `body` -> Job Description
   - `html_url` -> The URL to apply / view the issue.
   - `user.login` -> Treat the author or repo owner as the "Company".
4. **Database Insertion:**
   - Map this to our Prisma `job.create` payload.
   - Set `platform: 'github'`.
   - Set `status: 'new'`.
5. **Integration:**
   - Import the new `GET` function into `src/app/api/pipeline/run/route.ts`.
   - Add it to the native ingestion block alongside Apify, Reddit, and Hacker News inside its own `try/catch`.

## 3. Rate Limiting Considerations
GitHub's Search API has secondary rate limits. The script should only fetch 1 or 2 pages max per run, and we should highly recommend the user adds a `GITHUB_TOKEN` to their `.env` file.
