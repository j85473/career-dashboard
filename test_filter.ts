import { passesPreFilter } from './src/lib/jobFiltering';
async function main() {
  const job = {
    title: 'Regional Sales Lead (Minnesota & Iowa)',
    company: 'Halter',
    description: 'We are looking for a Regional Sales Lead...',
    location: 'Minnesota',
    url: 'https://jobs.ashbyhq.com/halter/...'
  };
  const result = passesPreFilter(job);
  console.log(result);
}
main();
