import docx

doc = docx.Document("/Users/JosephLamb/Desktop/Joseph_Lamb_Resume.docx")

def replace_p(index, new_text):
    p = doc.paragraphs[index]
    if len(p.runs) > 0:
        p.runs[0].text = new_text
        for r in p.runs[1:]:
            r.text = ""

replace_p(9, "Drove adoption during new product launches by cultivating high-trust relationships with channel partners and framing Go-To-Market (GTM) execution entirely around mutual revenue generation, bypassing typical launch friction to deliver 15%+ YoY network growth.")
replace_p(11, "Utilized proactive onboarding strategies to audit partner operations and identify operational flaws, immediately delivering actionable software and process solutions that established utility and reduced unresolved activations from 200+ to under 20 per week.")
replace_p(14, "Collaborated with internal reporting teams to build a centralized database utilizing cloud APIs to pair cancellation data with individual sales metrics, creating a data-driven framework to identify recurring patterns and address account churn.")

doc.save("/Users/JosephLamb/Desktop/Joseph_Lamb_Resume.docx")
print("Resume bullets updated successfully!")
