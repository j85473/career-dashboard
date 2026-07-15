import { runCronMain, runScheduledTask } from './http';

runCronMain(() => runScheduledTask('STARTING CONTEXT / DEEPSEEK UPDATE', '/api/pipeline/deepseek'));
