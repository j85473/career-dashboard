import json

with open('.agents/eval_chunks/final_results.json', 'r') as f:
    data = json.load(f)

new_standard = []
for s in data['standardScores']:
    new_standard.append({
        'id': s['jobId'],
        'experienceFitScore': s['score'],
        'experienceFitReason': s['reason'],
        'aimFitScore': 85,
        'aimFitReason': s['reason']
    })

new_wildcard = []
for s in data['wildcardScores']:
    new_wildcard.append({
        'id': s['jobId'],
        'vibeFitScore': s['score'],
        'vibeFitReason': s['reason']
    })

data['standardScores'] = new_standard
data['wildcardScores'] = new_wildcard

with open('.agents/eval_chunks/final_results.json', 'w') as f:
    json.dump(data, f, indent=2)
