import { updatePipelineState } from './src/lib/pipelineState';
updatePipelineState({ isRunning: false, currentStep: 'Idle', stepProgress: 'Stopped manually for fix.' });
console.log('Pipeline stopped.');
