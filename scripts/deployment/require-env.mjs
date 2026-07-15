const required = ['DATABASE_URL', 'PIPELINE_SECRET'];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error(`Missing required production environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Required production environment variables are configured.');
