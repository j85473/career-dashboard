const fs = require('fs');
if (fs.existsSync('.pipeline_state.json')) {
    const state = JSON.parse(fs.readFileSync('.pipeline_state.json', 'utf8'));
    state.isRunning = false;
    state.currentStep = 'Idle';
    state.stepProgress = 'Pipeline stopped by user.';
    fs.writeFileSync('.pipeline_state.json', JSON.stringify(state, null, 2));
    print('Pipeline state updated to stopped.');
}
