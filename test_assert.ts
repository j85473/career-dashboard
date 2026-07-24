import { assertSafeExternalUrl } from './src/lib/safeExternalFetch';
async function main() {
  const url = await assertSafeExternalUrl('https://www.adzuna.com/details/5805858554');
  console.log('Result:', url.toString());
}
main().catch(console.error);
