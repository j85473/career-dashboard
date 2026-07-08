import docx
import sys
import glob
import os

def read_docx(path):
    try:
        doc = docx.Document(path)
        return [para.text.strip() for para in doc.paragraphs if para.text.strip()]
    except Exception as e:
        return [str(e)]

baseline_bullets = [
    "Drove adoption during new product launches by cultivating high-trust relationships with channel partners and framing Go-To-Market (GTM) execution entirely around mutual revenue generation, bypassing typical launch friction to deliver 15%+ YoY network growth.",
    "Led the regional rollout and field enablement of Sara+ (proprietary order entry and reporting platform); served as the sole implementation resource across the territory, training 7 primary distributor offices and cascading adoption down to the store level.",
    "Utilized proactive onboarding strategies to audit partner operations and identify operational flaws, immediately delivering actionable software and process solutions that established utility and reduced unresolved activations from 200+ to under 20 per week.",
    "Engineered an automated post-sale support and retention framework for the region’s largest partner (representing 46% of regional volume), decreasing local account escalations by 82% and driving long-term partner success.",
    "Built direct working relationships with Target and Best Buy Key/National Account Managers, translating real-time store-level issues into field intelligence to accelerate resolution of complex account-level problems.",
    "Collaborated with internal reporting teams to build a centralized database utilizing cloud APIs to pair cancellation data with individual sales metrics, creating a data-driven framework to identify recurring patterns and address account churn."
]

directory = "/Users/JosephLamb/Library/CloudStorage/GoogleDrive-j85473@gmail.com/My Drive/Resumes/Dashboard Resumes"
for file in glob.glob(os.path.join(directory, "*.docx")):
    if "~$" in file: continue
    print(f"\n=== VERIFYING: {os.path.basename(file)} ===")
    lines = read_docx(file)
    
    # Check title and summary
    print("HEADER:")
    for i in range(2, min(5, len(lines))):
        print(f"  {lines[i]}")
        
    # Check if all baseline bullets exist in the resume
    missing = 0
    for bullet in baseline_bullets:
        if bullet not in lines:
            print(f"ERROR: Missing bullet: {bullet[:50]}...")
            missing += 1
            
    if missing == 0:
        print("RESULT: Body bullets match baseline perfectly.")
    else:
        print("RESULT: FAILURE. Body bullets were altered.")

