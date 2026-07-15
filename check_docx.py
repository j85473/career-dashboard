import docx

doc = docx.Document("/Users/JosephLamb/Desktop/Joseph_Lamb_Resume.docx")
for i in range(13, 22):
    try:
        p = doc.paragraphs[i]
        print(f"[{i}] {p.text}")
    except IndexError:
        break
