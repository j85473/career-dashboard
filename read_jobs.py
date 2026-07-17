import json
with open('/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard/chunks/chunk_62.json') as f:
    d = json.load(f)
for x in d:
    print(x['id'], x['title'], x['company'])
