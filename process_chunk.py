import json

filepath = '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/chunks/chunk_173.json'
with open(filepath, 'r') as f:
    data = json.load(f)

junk_ids = []
for job in data:
    title = job.get('title', '').lower()
    desc = job.get('description', '').lower()
    company = job.get('company', '').lower()
    
    if "agency owner" in title or "business ownership opportunity" in desc or "allstate" in company:
        junk_ids.append(job['id'])

res = {
    "junk_ids": junk_ids,
    "patterns": ["Insurance Agency Owner", "business ownership opportunity", "not employment"]
}

outpath = '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/chunks/chunk_173_result.json'
with open(outpath, 'w') as f:
    json.dump(res, f)

print(f"Found {len(junk_ids)} junk jobs out of {len(data)}")
