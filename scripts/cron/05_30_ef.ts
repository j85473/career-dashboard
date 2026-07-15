import { runCronMain, runScheduledTask } from './http';

runCronMain(() => runScheduledTask('STARTING EXPERIENCE FIT', '/api/pipeline/deepseek'));
