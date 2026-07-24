import { resolveRedirectUrl } from './src/lib/atsRedirect';

async function main() {
  const finalUrl = await resolveRedirectUrl('https://www.adzuna.com/details/5805858554?utm_medium=api&utm_source=9bac44d3');
  console.log('Final URL:', finalUrl);
}
main().catch(console.error);
