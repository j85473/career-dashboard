import os
import json
import urllib.request
import urllib.error
import time
import subprocess
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
PROGRESS_FILE = '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/scratch_auto_scoring_progress.json'
PROJECT_DIR = '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard'

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

def export_batch():
    cmd = [
        "npx", "tsx", "-e",
        """
        import { GET } from './src/app/api/scoring/export/route';
        async function run() {
          const res = await GET();
          const data = await res.json();
          console.log(JSON.stringify(data));
        }
        run();
        """
    ]
    result = subprocess.run(cmd, cwd=PROJECT_DIR, capture_output=True, text=True, check=True)
    return json.loads(result.stdout.strip())

def import_scores(batch_id, standard_scores):
    payload = json.dumps({
        "batchId": batch_id,
        "standardScores": standard_scores,
        "wildcardScores": []
    })
    cmd = [
        "npx", "tsx", "-e",
        f"""
        import {{ POST }} from './src/app/api/scoring/import/route';
        async function run() {{
          const req = new Request('http://localhost/api/scoring/import', {{
            method: 'POST',
            headers: {{ 'Content-Type': 'application/json' }},
            body: JSON.stringify({payload})
          }});
          const res = await POST(req);
          const data = await res.json();
          console.log(JSON.stringify(data));
        }}
        run();
        """
    ]
    result = subprocess.run(cmd, cwd=PROJECT_DIR, capture_output=True, text=True, check=True)
    return json.loads(result.stdout.strip())

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

def run_pipeline():
    print("Starting automated scoring pipeline...")
    export_data = export_batch()
    batch_id = export_data.get('batchId')
    standard_jobs = export_data.get('standardJobs', [])
    
    print(f"Created batch {batch_id} with {len(standard_jobs)} standard jobs.")
    if not standard_jobs:
        print("No pending jobs to score.")
        return

    CHUNK_SIZE = 5
    chunks = []
    for i in range(0, len(standard_jobs), CHUNK_SIZE):
        chunk_jobs = standard_jobs[i:i+CHUNK_SIZE]
        chunks.append((i // CHUNK_SIZE, chunk_jobs))
        
    print(f"Evaluating {len(chunks)} chunks using 2-worker concurrency pool...")
    
    scored_map = {}
    CONCURRENCY = 2
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        futures = {executor.submit(evaluate_chunk, chunk, idx): (idx, chunk) for idx, chunk in chunks}
        for future in as_completed(futures):
            idx, chunk = futures[future]
            try:
                scores = future.result()
                for s in scores:
                    if isinstance(s, dict) and 'id' in s:
                        scored_map[s['id']] = s
                # Save progress
                with open(PROGRESS_FILE, 'w') as f:
                    json.dump(scored_map, f)
            except Exception as e:
                print(f"Error processing chunk {idx}: {e}")

    # Check missing jobs
    missing = [j for j in standard_jobs if j['id'] not in scored_map]
    if missing:
        print(f"Fixing {len(missing)} missing jobs...")
        cleanup_res = evaluate_chunk(missing, 9999)
        for s in cleanup_res:
            if isinstance(s, dict) and 'id' in s:
                scored_map[s['id']] = s

    scores_list = list(scored_map.values())
    print(f"Completed evaluation for {len(scores_list)} jobs. Importing to database...")
    
    import_result = import_scores(batch_id, scores_list)
    print("Import complete:", json.dumps(import_result, indent=2))

if __name__ == '__main__':
    run_pipeline()
