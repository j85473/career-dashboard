import { runCronMain, runScheduledTask } from './http';

runCronMain(() => runScheduledTask('STARTING LINKEDIN DRAFT BATCH', '/api/linkedin/batch', 180_000));
