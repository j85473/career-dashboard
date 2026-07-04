import re

with open("src/components/ScoringLogTab.tsx", "r") as f:
    content = f.read()

# Add pipeline state variables at the beginning of the component
content = content.replace(
    "const [jobs, setJobs] = useState<any[]>([]);",
    "const [jobs, setJobs] = useState<any[]>([]);\n  const [pipelineState, setPipelineState] = useState<any>(null);"
)

# Add pipeline status polling
content = content.replace(
    "const interval = setInterval(fetchJobs, 5000); // refresh every 5 seconds for snappier UI",
    """const interval = setInterval(fetchJobs, 5000); // refresh every 5 seconds for snappier UI
    
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/pipeline/status');
        const data = await res.json();
        setPipelineState(data);
      } catch (e) {}
    };
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 3000);"""
)

# Add cleanup for status interval
content = content.replace(
    "clearInterval(interval);",
    "clearInterval(interval);\n      clearInterval(statusInterval);"
)

# Replace all the individual manual process buttons and logic
# Lines 130 to 273 is where the buttons are
button_pattern = re.compile(r"\{activeLogTab === 'queue'.*?</div>\s*</div>\s*<div style=\{\{ display: 'flex'", re.DOTALL)

replacement_buttons = """
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {pipelineState?.isRunning ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--surface)', padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" className="progress-ring-svg">
                <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.1)" strokeWidth="3" fill="none" />
                <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="3" fill="none" strokeDasharray="62.8" strokeDashoffset="62.8" className="progress-ring-circle" strokeLinecap="round" />
              </svg>
              <div>
                <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--accent)' }}>Pipeline Running: {pipelineState.currentStep}</div>
                <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{pipelineState.stepProgress}</div>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={async () => {
              setPipelineState({ isRunning: true, currentStep: 'Starting...', stepProgress: 'Initializing pipeline' });
              await fetch('/api/pipeline/run', { method: 'POST' });
            }}>
              Run Full Pipeline
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex'"""

content = re.sub(r"\{activeLogTab === 'queue'[\s\S]*?</div>\s*</div>\s*\{loading", replacement_buttons + "\n\n      {loading", content)

with open("src/components/ScoringLogTab.tsx", "w") as f:
    f.write(content)
print("Updated successfully")
