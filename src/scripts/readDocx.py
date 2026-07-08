import docx
import sys

def read_docx(path):
    try:
        doc = docx.Document(path)
        text = [para.text for para in doc.paragraphs if para.text.strip()]
        return '\n'.join(text)
    except Exception as e:
        return str(e)

if __name__ == '__main__':
    print("=== TAILORED RESUME ===")
    print(read_docx(sys.argv[1]))
