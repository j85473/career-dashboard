import * as mammoth from 'mammoth';
import * as fs from 'fs';
import * as path from 'path';

export interface ResumeData {
  name: string;
  text: string;
}

export async function getAllResumes(): Promise<ResumeData[]> {
  const resumesDir = path.join(process.cwd(), 'data', 'resumes');
  
  if (!fs.existsSync(resumesDir)) {
    throw new Error(`Resumes directory not found at path: ${resumesDir}`);
  }

  const files = fs.readdirSync(resumesDir).filter(f => f.endsWith('.docx'));
  const resumes: ResumeData[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(resumesDir, file);
      const result = await mammoth.extractRawText({ path: filePath });
      // Extract a clean name, e.g., "AI" from "Generic_User_Control_Resume_3.0_AI.docx"
      let name = file.replace('.docx', '');
      if (name.includes('_')) {
        name = name.split('_').pop() || name;
      }
      resumes.push({
        name,
        text: result.value
      });
    } catch (error) {
      console.error(`Error extracting text from ${file}:`, error);
    }
  }

  return resumes;
}
