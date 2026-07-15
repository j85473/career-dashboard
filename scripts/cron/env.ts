import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const inheritedEnvironment = { ...process.env };

for (const filename of ['.env', '.env.production', '.env.local', '.env.production.local']) {
  const filePath = path.join(root, filename);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: true, quiet: true });
  }
}

// Service/cron environment variables take precedence over dotenv files.
Object.assign(process.env, inheritedEnvironment);
