const mammoth = require('mammoth');
const fs = require('fs');

async function extract() {
  const result = await mammoth.extractRawText({ path: 'data/resumes/JosephLamb.CS.resume.docx' });
  
  // The exact text extracted by mammoth
  const text = result.value;
  
  // Compact text the exact same way prepare_native_scoring_phase does
  const compactText = (str, limit) => {
    const compact = str.replace(/\s+/g, ' ').trim();
    return limit ? compact.slice(0, limit) : compact;
  };
  
  const compact = compactText(text, 50000);
  
  fs.writeFileSync('mammoth_output.txt', text);
  fs.writeFileSync('mammoth_compact.txt', compact);
  
  console.log("Successfully extracted text and saved to mammoth_output.txt");
}

extract().catch(console.error);
