const required = ['DATABASE_URL', 'PIPELINE_SECRET', 'SCORING_APPROVAL_SECRET'];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  console.error(`Missing required production environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

if (Buffer.byteLength(process.env.SCORING_APPROVAL_SECRET, 'utf8') < 32) {
  console.error('SCORING_APPROVAL_SECRET must contain at least 32 UTF-8 bytes.');
  process.exit(1);
}

console.log('Required production environment variables are configured.');
