import { runCrawlArchive } from '../archive_ats_crawls';

runCrawlArchive(process.argv.slice(2)).catch(error => {
  console.error(String(error));
  process.exitCode = 1;
});
