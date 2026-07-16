import * as mammoth from 'mammoth';
import * as fs from 'fs';
import * as path from 'path';

export interface ResumeData {
  name: string;
  text: string;
}

let cachedResumes: ResumeData[] | null = null;

export async function getAllResumes(): Promise<ResumeData[]> {
  if (cachedResumes) {
    return cachedResumes;
  }

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
      resumes.push({
        name: file.replace(/\.docx$/i, ''),
        text: result.value
      });
    } catch (error) {
      console.error(`Error extracting text from ${file}:`, error);
    }
  }

  cachedResumes = resumes;
  return resumes;
}
