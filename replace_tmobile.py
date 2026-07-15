import docx
import sys

try:
    doc = docx.Document("/Users/JosephLamb/Desktop/Joseph_Lamb_Resume.docx")
    p = doc.paragraphs[25]
    
    new_text = "Cultivated strategic partnerships with local business coalitions and Chambers of Commerce to build an outbound lead-generation pipeline, establishing the store as a primary technology vendor for regional SMBs."
    
    if len(p.runs) > 0:
        p.runs[0].text = new_text
        for r in p.runs[1:]:
            r.text = ""
            
    doc.save("/Users/JosephLamb/Desktop/Joseph_Lamb_Resume.docx")
    print("T-Mobile bullet replaced successfully!")
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
