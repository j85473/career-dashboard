import json

with open('/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/chunks/chunk_110.json', 'r') as f:
    jobs = json.load(f)

junk_ids = []
patterns = set()

for job in jobs:
    desc = job.get('description', '')
    title = job.get('title', '')
    
    is_junk = False
    
    if 'Google Chrome' in desc and 'Microsoft Edge' in desc and 'Mozilla Firefox' in desc:
        is_junk = True
        patterns.add('browser_check_header')
        
    if 'must currently work in a' in desc and 'Chick-fil-A' in desc:
        is_junk = True
        patterns.add('internal_only')
        
    if 'Training' in title and 'OPT' in desc:
        is_junk = True
        patterns.add('training_placement')

    if is_junk:
        if job['id'] not in junk_ids:
            junk_ids.append(job['id'])

with open('/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/chunks/chunk_110_result.json', 'w') as f:
    json.dump({"junk_ids": junk_ids, "patterns": list(patterns)}, f)

print(f"Found {len(junk_ids)} junk jobs out of {len(jobs)}")
