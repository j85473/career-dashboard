import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? '\n' : ' ';
      }
      pages.push(pageText.trim());
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}
