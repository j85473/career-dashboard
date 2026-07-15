import { runCronMain, runScheduledTask } from './http';

runCronMain(() => runScheduledTask('STARTING AIM / EXPERIENCE FIT', '/api/pipeline/deepseek'));
