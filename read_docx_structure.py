import docx

doc = docx.Document("/Users/JosephLamb/Desktop/Joseph_Lamb_Resume.docx")
for i, p in enumerate(doc.paragraphs):
    if len(p.text.strip()) > 0:
        print(f"[{i}] {p.text.strip()}")
