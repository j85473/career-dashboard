import docx

doc = docx.Document("/Users/JosephLamb/Desktop/Joseph_Lamb_Channel_Sales_Resume.docx")

p = doc.paragraphs[3]
if len(p.runs) > 0:
    p.runs[0].text = p.runs[0].text.replace("6+ years", "7+ years")

doc.save("/Users/JosephLamb/Desktop/Joseph_Lamb_Channel_Sales_Resume.docx")
print("Years of experience updated in DOCX successfully!")
