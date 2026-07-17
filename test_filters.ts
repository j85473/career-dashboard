import { passesPreFilter } from './src/lib/jobFiltering';

const titles = [
  "Salesforce Solutions Architect",
  "Integration Engineer - REMOTE",
  "Senior DevOps Engineer",
  "Senior Rust Engineer",
  "BizDev/Partnership Director",
  "Business Analyst/ Technical Writer/Researcher",
  "Research Analyst in Web 3 - Remote",
  "Open Application",
  "Cloud Data Engineer",
  "Senior Field Marketer, Italian Speaker (Remote)"
];

let allRejected = true;

for (const title of titles) {
  const result = passesPreFilter({ title, description: '', location: '', url: '', company: 'Test Company' });
  if (result.passes) {
    console.error(`❌ FAILED: "${title}" passed the filter but should have been rejected.`);
    allRejected = false;
  } else {
    console.log(`✅ OK: "${title}" rejected. Reason: ${result.reason}`);
  }
}

if (allRejected) {
  console.log('\nAll test titles were correctly rejected!');
} else {
  console.error('\nSome test titles failed.');
  process.exit(1);
}
