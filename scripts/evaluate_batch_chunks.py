import os
import json
import urllib.request
import urllib.error
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any

# Load environment variables
dotenv_path = '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/.env'
if os.path.exists(dotenv_path):
    with open(dotenv_path) as f:
        for line in f:
            if '=' in line and not line.startswith('#'):
                parts = line.strip().split('=', 1)
                if len(parts) == 2:
                    os.environ[parts[0]] = parts[1].strip('\"\'')

DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY')
EXPORT_FILE_PATH = '/Users/JosephLamb/Desktop/scoring_batch_manual_export_53dd6963-d42d-4cfc-921c-de1a2c463a85.json'
PROGRESS_FILE = '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/scratch_scoring_progress_53dd6963.json'

SYSTEM_PROMPT = """You are a precise AI Job Evaluator for a Field Sales / Strategic Account Management professional.

CANDIDATE PERSONA:
- Experience: 7+ years of experience in channel sales, partner enablement, territory management, distributor execution, and key account management across 155+ locations and major retailers.
- Target Roles: Technical Sales, Sales Manager, District Sales Manager, Field Sales Rep, Field Manager, Account Executive, Account Director, Channel Sales, Distributor Sales, Customer Success (and variants).
- Core Strengths: High agency, field sales, territory growth, partner enablement, distributor relations, B2B strategic accounts.
- Location Constraint: Candidate MUST be based in the Minneapolis metro area (or 100% remote). Reject jobs requiring physical relocation to reside in another city. (Territories covering upper Midwest/multiple states are fine as long as base location is Minneapolis/remote).

DO NOT BLOCK SALES:
- Do NOT reject general B2B sales roles (Account Executive, Sales Manager, Channel Sales, District Manager, etc.).
- Do NOT confuse candidate with Product Manager, Software Engineer, or Technical PM.

HARD REJECT CONSTRAINTS (Assign aimFitScore < 50 and experienceFitScore < 50):
- Retail sales, store manager, consumer retail (e.g. store floor associate, retail store director, counter sales).
- Manual labor, maintenance, trades, blue collar roles.
- Loan officer, mortgage broker.
- Property management, leasing consultant.
- Staffing agency / recruitment agency roles (e.g. staffing recruiter, staffing account executive at recruiting agency).
- Event technology sales, wireless tech retail sales, cryo tank sales.
- Software Engineer, Junior Software Engineer, Engineering Manager, Software Developer.
- Roles requiring residing physically on-site in a city outside Minneapolis metro.
- Long-term care / assisted living.

SCORING CRITERIA (0 to 100 integer scale):
- aimFitScore: Strategic fit for candidate's target roles (Field Sales, Channel Sales, Account Executive, Account Director, Sales Management, Customer Success). High score (80-100) for strong sales/account management roles. Low score (<50) for unrelated fields (nursing, software dev, early childhood education, quality engineer, etc.).
- experienceFitScore: Alignment with 7+ years B2B/channel/account management experience.
- travelScore: Score 75-100 for field/territory roles with travel; score lower (30-50) for desk-only office roles.
- atsSystem: Detect ATS system (e.g., Workday, Greenhouse, Lever, Taleo, iCIMS, Ashby, SmartRecruiters, Jobvite) from job text if detectable, else null.
- compensation: Extract salary/OTE range string if explicitly mentioned in job text, else null.

OUTPUT REQUIREMENT:
Return ONLY a valid JSON array of evaluated job objects. Do NOT include markdown code blocks or extra text.
Format:
[
  {
    "id": "job_id",
    "aimFitScore": 85,
    "aimFitReason": "Concise evidence-based reason",
    "experienceFitScore": 90,
    "experienceFitReason": "Concise evidence-based reason",
    "travelScore": 80,
    "atsSystem": "Workday" or null,
    "compensation": "$120,000 - $150,000" or null
  }
]
"""

def evaluate_chunk(chunk: List[Dict[str, Any]], chunk_idx: int) -> List[Dict[str, Any]]:
    payload = {
        "model": "deepseek-v4-flash",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(chunk)}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1
    }
    
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json"
    }
    
    url = "https://api.deepseek.com/chat/completions"
    data_bytes = json.dumps(payload).encode('utf-8')
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers=headers, data=data_bytes)
            with urllib.request.urlopen(req, timeout=45) as resp:
                res_json = json.loads(resp.read().decode('utf-8'))
                content = res_json["choices"][0]["message"]["content"].strip()
                parsed = json.loads(content)
                
                if isinstance(parsed, list):
                    scores = parsed
                elif isinstance(parsed, dict):
                    scores = parsed.get("jobScores") or parsed.get("jobs") or list(parsed.values())[0]
                else:
                    raise ValueError("Unexpected JSON response structure")
                
                print(f"Chunk {chunk_idx}: Successfully evaluated {len(scores)} jobs.")
                return scores
        except Exception as e:
            print(f"Chunk {chunk_idx} Attempt {attempt+1} exception: {e}")
            time.sleep(2)
            
    print(f"Chunk {chunk_idx} FAILED after {max_retries} attempts.")
    return [{
        "id": job["id"],
        "aimFitScore": 0,
        "aimFitReason": "AI scoring request failed",
        "experienceFitScore": 0,
        "experienceFitReason": "AI scoring request failed",
        "travelScore": 0,
        "atsSystem": None,
        "compensation": None
    } for job in chunk]

def main():
    with open(EXPORT_FILE_PATH, 'r') as f:
        export_data = json.load(f)
        
    batch_id = export_data.get('batchId')
    standard_jobs = export_data.get('standardJobs', [])
    print(f"Batch ID: {batch_id}, Total Jobs: {len(standard_jobs)}")
    
    scored_results = {}
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, 'r') as f:
                scored_results = json.load(f)
            print(f"Loaded existing progress: {len(scored_results)} jobs already scored.")
        except Exception:
            scored_results = {}
            
    CHUNK_SIZE = 5
    chunks = []
    for i in range(0, len(standard_jobs), CHUNK_SIZE):
        chunk_jobs = standard_jobs[i:i+CHUNK_SIZE]
        unscored = [j for j in chunk_jobs if j['id'] not in scored_results]
        if unscored:
            chunks.append((i // CHUNK_SIZE, unscored))
            
    print(f"Remaining chunks to evaluate: {len(chunks)}")
    if not chunks:
        print("All jobs are already evaluated!")
        return

    CONCURRENCY = 2
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        futures = {executor.submit(evaluate_chunk, chunk, idx): (idx, chunk) for idx, chunk in chunks}
        for future in as_completed(futures):
            idx, chunk = futures[future]
            try:
                scores = future.result()
                for s in scores:
                    if isinstance(s, dict) and 'id' in s:
                        scored_results[s['id']] = s
                # Save progress incrementally
                with open(PROGRESS_FILE, 'w') as f:
                    json.dump(scored_results, f)
            except Exception as e:
                print(f"Error processing chunk {idx}: {e}")

    print(f"Completed evaluation for total {len(scored_results)} jobs.")

if __name__ == '__main__':
    main()
