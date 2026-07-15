import { runCronMain, runScheduledTask } from './http';

runCronMain(() => runScheduledTask('STARTING NEEDS-JD QUEUE', '/api/jobs/batch-jd-submit'));
